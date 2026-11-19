import { afterEach, describe, expect, test, vi } from "vitest";
import { HEAD_SHA, delegate, disposeAll, setup, start } from "./test/harness";
import { PR_URL, forgeAnswers, openGate, readyIdle, reviewerVerdict, rowOf, spawnOf, testerReady, tool, workerOn, delegateWave, plan, type Gate, type State } from "./test/testerHelpers";
import { section } from "./test/specWriterHelpers";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

const BRANCH = "feature/x";
const FINDING = "Totals go negative.";
// A tester result longer than SUMMARY_MAX (800) is stored in a report file, which the fix brief then names.
const LONG_FAILURE = `Tests fail.\n\n${"Output line of a failing run. ".repeat(40)}\n\n## Deviations from plan\nNone.\n\n## Failing tests\n- totals.test.ts:3 — \`npx vitest run totals.test.ts\`, exit 1: totals go negative (totals.ts:4)`;
const targetLine = (id: string) => `- ${id}: branch ${BRANCH}, ${PR_URL}, pinned ${HEAD_SHA}`;

/** A one-wave plan whose worker is ready on a pull request, with the review gate open on it. */
async function gated(state: State) {
  forgeAnswers(undefined, "OPEN");
  const chief = await start(state);
  const planner = await plan(state, chief.threadId);
  await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: BRANCH, prUrl: PR_URL });
  const worker = workerOn(state, planner.threadId, 1).thread_id as string;
  await readyIdle(state, worker);
  return { chief, planner, worker, gate: (await openGate(state, chief.threadId, worker)) as Gate };
}
/** Chief closes the gate by override (the user accepted it): tester, reviewer, then the target. */
async function closeGate(state: State, chiefThreadId: string, gate: Gate, worker: string) {
  for (const id of [gate.tester_thread_id, gate.reviewer_thread_id, worker]) await tool(state, "chief_complete", { threadId: id, override: "user accepted the gate" }, chiefThreadId);
  expect(rowOf(state, worker).state).toBe("complete");
}
const fixRunSection = (state: State, threadId: string) => section(spawnOf(state, threadId).prompt as string, "Fix run");

describe("repair briefs", () => {
  // plan-5 contract 1 (gate fix run): after a red tester and a request_changes verdict, Chief's one fix run replaces the gate tester and its
  // brief carries every gate target (branch, PR, pinned sha), the reviewer's verdict file and findings, and the tester's report path.
  // Regression: a target, the verdict path or a finding is dropped from the brief, so the fix run starts blind.
  test("a gate fix run's brief names every gate target, the reviewer verdict file and findings and the tester report path", async () => {
    const state = await setup();
    const { chief, worker, gate } = await gated(state);
    await testerReady(state, gate, false, LONG_FAILURE);
    await reviewerVerdict(state, gate, "request_changes");
    const fixRun = (await delegate(state, chief.threadId, "Fix the gate", { replaces: gate.tester_thread_id, kind: "worker" })).threadId;
    expect(rowOf(state, fixRun)).toMatchObject({ fix_run: "gate" });
    const brief = fixRunSection(state, fixRun);
    expect(brief).toContain(targetLine(worker));
    expect(brief).toContain(rowOf(state, gate.reviewer_thread_id).verdict_path);
    expect(brief).toContain("totals.ts:4");
    expect(brief).toContain(FINDING);
    expect(brief).toContain(rowOf(state, gate.tester_thread_id).report_path);
    expect(brief).toContain("totals.test.ts:3");
  });

  // plan-5 contract 1 (evidence outlives the reviewer row): the reviewer row is complete by the time Chief starts the fix run; its verdict
  // path and findings still reach the brief. Regression: the brief reads findings only from an open reviewer row.
  test("a gate fix run's brief keeps the reviewer's findings when the reviewer row is complete", async () => {
    const state = await setup();
    const { chief, gate } = await gated(state);
    await testerReady(state, gate, false, LONG_FAILURE);
    await reviewerVerdict(state, gate, "request_changes");
    await tool(state, "chief_complete", { threadId: gate.reviewer_thread_id, override: "verdict recorded" }, chief.threadId);
    expect(rowOf(state, gate.reviewer_thread_id).state).toBe("complete");
    const fixRun = (await delegate(state, chief.threadId, "Fix the gate", { replaces: gate.tester_thread_id, kind: "worker" })).threadId;
    const brief = fixRunSection(state, fixRun);
    expect(brief).toContain(rowOf(state, gate.reviewer_thread_id).verdict_path);
    expect(brief).toContain(FINDING);
  });

  // plan-5 contract (chat fix): a change the user asks for on completed work is a chat fix: the same Fix run rules, but no verdict, no
  // findings and no tester evidence from the old gate are replayed. Regression: a chat fix inherits the old findings and fixes them again.
  test("a chat fix's brief has the fix run rules and replays no old findings", async () => {
    const state = await setup();
    const { chief, worker, gate } = await gated(state);
    await testerReady(state, gate, false, LONG_FAILURE);
    await reviewerVerdict(state, gate, "request_changes");
    await closeGate(state, chief.threadId, gate, worker);
    const chat = (await delegate(state, chief.threadId, "Change the label", { replaces: worker, kind: "worker" })).threadId;
    expect(rowOf(state, chat)).toMatchObject({ fix_run: "chat" });
    const prompt = spawnOf(state, chat).prompt as string;
    const brief = section(prompt, "Fix run");
    expect(brief).toContain(`origin/${BRANCH}`);
    for (const replayed of [FINDING, "totals.ts:4", "totals.test.ts:3", gate.reviewer_thread_id, rowOf(state, gate.reviewer_thread_id).verdict_path, "Gate targets"]) expect(brief).not.toContain(replayed);
    expect(prompt).not.toContain(FINDING);
  });

  // plan-5 contract (test ownership): a plain worker never runs tests; a fix run does, as its Fix run section says (a chat fix is the reachable fix run, see the gate fix defect). Regression: the fix run
  // keeps the never-run line and cannot verify its own change, or a plain worker is allowed to run tests.
  test("only the fix run brief has a Fix run section", async () => {
    const state = await setup();
    const { chief, worker, gate } = await gated(state);
    const plain = spawnOf(state, (await delegate(state, chief.threadId, "Plain work")).threadId).prompt as string;
    await closeGate(state, chief.threadId, gate, worker);
    const fixPrompt = spawnOf(state, (await delegate(state, chief.threadId, "Change the label", { replaces: worker, kind: "worker" })).threadId).prompt as string;
    expect(plain).not.toContain("## Fix run");
    expect(fixPrompt).toContain("## Fix run");
  });

  // plan-5 contract (gate tester): the one gate tester's brief lists every gate target with branch, PR, pinned sha and base.
  // Regression: the tester tests a moving branch head or the wrong base.
  test("the gate tester's brief has Gate targets with branch, pull request, pinned sha and base", async () => {
    const state = await setup();
    const { worker, gate } = await gated(state);
    const targets = section(spawnOf(state, gate.tester_thread_id).prompt as string, "Gate targets");
    expect(targets).toContain(`${targetLine(worker)}, base main`);
    expect(JSON.parse(gate.targets)).toEqual([expect.objectContaining({ threadId: worker, branch: BRANCH, prUrl: PR_URL, headSha: HEAD_SHA, base: "main" })]);
  });
});
