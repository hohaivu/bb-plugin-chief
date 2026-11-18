import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { PLAN_FIXTURE, disposeAll, wave } from "./test/harness";
import { type GateWorld, gateWorld } from "./test/gateWorld";
import { delegateWave, plan } from "./test/testerHelpers";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (the one review gate, src/runtime/completion.ts): chief_complete on a gate's target completes only when the gate decision is pass
// (approve and green tests, or a fix run / corrector that ended green). Every other decision refuses and names its next step.
// skipReview completes with no gate and no cleanup; override completes without the gate, also with no cleanup. A pass stamps cleanup_approved_at.
const refused = (world: GateWorld, threadId: string, extra: object = {}) => world.refusal(world.complete(threadId, extra));
const asThread = (threadId: string) => ({ threadId, projectId: "proj_1" });

describe("a passed gate completes the target", () => {
  test("approve and green tests: the worker completes", async () => {
    const world = await gateWorld();
    const { worker } = await world.passed();
    await world.complete(worker.threadId);
    expect(world.row(worker.threadId).state).toBe("complete");
  });

  test("red tests, then a fix run that ends green: the worker completes", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "approve");
    await world.testReport(tester, false);
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    await world.ready(fix.threadId, { testsPassed: true });
    await world.complete(worker.threadId);
    expect(world.row(worker.threadId).state).toBe("complete");
  });

  test("a fix run that is blocked on a wrong test, then a corrector that ends green: the worker completes", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "approve");
    await world.testReport(tester, false);
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    await world.block(fix.threadId, "The test contradicts the plan.");
    const corrector = await world.delegateTo({ replaces: fix.threadId, kind: "tester" });
    await world.testReport(corrector.threadId, true);
    world.setIdle(corrector.threadId);
    await world.complete(worker.threadId);
    expect(world.row(worker.threadId).state).toBe("complete");
  });
});

describe("a gate that has not passed refuses completion with its next step", () => {
  test("red tests with no fix run: refused, with the fix line", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "approve");
    await world.testReport(tester, false);
    const message = await refused(world, worker.threadId);
    expect(message).toContain("has not passed (fix)");
    expect(message).toContain(`chief_delegate (replaces: ${tester}, kind: worker)`);
    expect(world.row(worker.threadId).state).not.toBe("complete");
  });

  test("request_changes with a code finding: refused, with the fix line", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "request_changes");
    await world.testReport(tester, true);
    expect(await refused(world, worker.threadId)).toContain("has not passed (fix)");
  });

  test("the review's two sides still running: refused, waiting", async () => {
    const world = await gateWorld();
    const { worker } = await world.gated();
    expect(await refused(world, worker.threadId)).toContain("has not passed (wait)");
  });

  test.each([
    ["the tester blocked", "tester", (world: GateWorld, id: string) => world.block(id)],
    ["the reviewer blocked", "reviewer", (world: GateWorld, id: string) => world.block(id, "Cannot read the diff.")],
    ["the tester archived", "tester", async (world: GateWorld, id: string) => { world.state.live.set(id, { ...world.state.live.get(id)!, archivedAt: Date.now() } as any); await world.state.supervisorCycle(); }],
  ])("%s: refused, with the restart line", async (_name, side, down) => {
    const world = await gateWorld();
    const gated = await world.gated();
    if (side === "tester") await world.verdict(gated.reviewer, "approve"); else await world.testReport(gated.tester, true);
    await down(world, side === "tester" ? gated.tester : gated.reviewer);
    const message = await refused(world, gated.worker.threadId);
    expect(message).toContain("has not passed (restart)");
    expect(message).toContain(`chief_review (workerThreadId: ${gated.worker.threadId})`);
  });

  test("a fix run's ready report without testsPassed is refused at intake, and so is testsPassed: false", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "approve");
    await world.testReport(tester, false);
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    const ready = { state: "ready", result: "Fixed.\n\n## Deviations from plan\nNone" };
    expect(await world.refusal(world.call("chief_report", ready, asThread(fix.threadId)))).toContain("testsPassed is missing");
    expect(await world.refusal(world.call("chief_report", { ...ready, testsPassed: false }, asThread(fix.threadId)))).toContain("A fix run reports ready only with testsPassed: true");
    expect(world.row(fix.threadId).tests_passed).toBeNull();
  });

  test("a corrector that ends red, or blocked: the gate escalates and the worker is refused", async () => {
    for (const ending of ["red", "blocked"] as const) {
      const world = await gateWorld();
      const { worker, reviewer, tester } = await world.gated();
      await world.verdict(reviewer, "approve");
      await world.testReport(tester, false);
      const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
      await world.block(fix.threadId, "The test contradicts the plan.");
      const corrector = await world.delegateTo({ replaces: fix.threadId, kind: "tester" });
      if (ending === "red") await world.testReport(corrector.threadId, false); else await world.block(corrector.threadId);
      const message = await refused(world, worker.threadId);
      expect(message).toContain("has not passed (escalate)");
      expect(message).toContain("Escalate to the user");
      await disposeAll();
    }
  });

  test("the target reports again after the gate pinned it: the gate escalates, even with approve and green tests", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "approve");
    await world.testReport(tester, true);
    await world.ready(worker.threadId, { result: "Changed it again.\n\n## Deviations from plan\nNone" });
    const message = await refused(world, worker.threadId);
    expect(message).toContain("has not passed (escalate)");
    expect(message).toContain(`${worker.threadId} changed after the gate pinned it`);
  });

  test("a worker with no gate is refused with the start line", async () => {
    const world = await gateWorld();
    const worker = await world.worker();
    await world.ready(worker.threadId);
    const message = await refused(world, worker.threadId);
    expect(message).toContain("has no review gate");
    expect(message).toContain(`chief_review (workerThreadId: ${worker.threadId}`);
  });
});

describe("skipReview", () => {
  test("completes a ready worker with no gate, and queues no cleanup", async () => {
    const world = await gateWorld({ cleanup: true });
    const worker = await world.worker();
    await world.ready(worker.threadId);
    const text = await world.complete(worker.threadId, { skipReview: "A one-line change." });
    expect(world.row(worker.threadId)).toMatchObject({ state: "complete", cleanup_approved_at: null });
    expect(text).toContain("No cleanup: completed without the gate.");
    expect(world.gate()).toBeUndefined();
  });

  test("is refused while the gate's reviewer or tester is still working", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.gated();
    expect(await refused(world, worker.threadId, { skipReview: "Quick." })).toContain(`review ${reviewer} is still running`);
    await world.verdict(reviewer, "approve");
    expect(await refused(world, worker.threadId, { skipReview: "Quick." })).toContain(`review gate ${world.gate().gate_key} is still running ${tester}`);
    expect(world.row(worker.threadId).state).not.toBe("complete");
  });

  test("is refused without a ready report", async () => {
    const world = await gateWorld();
    const worker = await world.worker();
    world.setIdle(worker.threadId);
    expect(await refused(world, worker.threadId, { skipReview: "Quick." })).toContain("not ready");
  });

  test("is refused on a design wave", async () => {
    const world = await gateWorld();
    const planner = await plan(world.state, world.chief, [{ body: PLAN_FIXTURE, design: true }, { body: wave(2), dependsOn: [1] }]);
    await delegateWave(world.state, world.chief, planner.threadId, 1);
    const designer = world.state.db.prepare(`SELECT thread_id FROM managed_threads WHERE plan_thread_id=? AND role='worker'`).get(planner.threadId) as { thread_id: string };
    await world.ready(designer.thread_id);
    expect(await refused(world, designer.thread_id, { skipReview: "Quick." })).toContain("design-only work");
  });

  test("is refused together with override, and with an empty reason", async () => {
    const world = await gateWorld();
    const worker = await world.worker();
    await world.ready(worker.threadId);
    expect(await refused(world, worker.threadId, { skipReview: "Quick.", override: "Also." })).toContain("not both");
    expect(await refused(world, worker.threadId, { skipReview: "" })).toContain("skipReview");
    expect(world.row(worker.threadId).state).not.toBe("complete");
  });
});

describe("override", () => {
  test("completes a worker whose gate has not passed, records the reason, and queues no cleanup", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "approve");
    await world.testReport(tester, false);
    const text = await world.complete(worker.threadId, { override: "The test is known flaky." });
    expect(world.row(worker.threadId)).toMatchObject({ state: "complete", cleanup_approved_at: null });
    expect(world.row(worker.threadId).result).toContain("Completed without the review gate: The test is known flaky.");
    expect(text).toContain("No cleanup: completed without the gate.");
  });
});

describe("cleanup approval", () => {
  test("a pass stamps cleanup_approved_at on the worker, and the idle reviewer and tester complete with it", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker, reviewer, tester } = await world.passed();
    const text = await world.complete(worker.threadId);
    for (const id of [worker.threadId, reviewer, tester]) expect(world.row(id)).toMatchObject({ state: "complete" });
    for (const id of [worker.threadId, reviewer, tester]) expect(world.row(id).cleanup_approved_at).not.toBeNull();
    expect(text).toContain("Cleanup queued");
  });

  test("with cleanup off, a pass completes the actors and stamps nothing", async () => {
    const world = await gateWorld({ cleanup: false });
    const { worker, reviewer, tester } = await world.passed();
    const text = await world.complete(worker.threadId);
    for (const id of [worker.threadId, reviewer, tester]) expect(world.row(id)).toMatchObject({ state: "complete", cleanup_approved_at: null });
    expect(text).toContain("the cleanupApproved setting is off");
  });

  test("a fix run's pass stamps the worker, the reviewer and the fix run; the replaced tester is eligible through its replacement", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker, reviewer, tester } = await world.gated();
    await world.verdict(reviewer, "approve");
    await world.testReport(tester, false);
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    await world.ready(fix.threadId, { testsPassed: true });
    await world.complete(worker.threadId);
    for (const id of [worker.threadId, reviewer, tester, fix.threadId]) expect(world.row(id)).toMatchObject({ state: "complete" });
    for (const id of [worker.threadId, reviewer, fix.threadId]) expect(world.row(id).cleanup_approved_at).not.toBeNull();
    expect(world.row(fix.threadId).replaces_thread_id).toBe(tester);
  });
});

describe("an implementation-lane Spec Writer", () => {
  test("is refused completion, and the refusal names the worker to delegate", async () => {
    const world = await gateWorld();
    const worker = await world.worker();
    await world.ready(worker.threadId);
    const writer = await world.delegateTo({ replaces: worker.threadId, kind: "spec-writer" });
    await world.ready(writer.threadId);
    const message = await refused(world, writer.threadId, { skipReview: "Docs only." });
    expect(message).toContain("a Spec Writer's docs need their worker");
    expect(message).toContain(`replaces: ${writer.threadId}, kind: worker`);
    expect(world.row(writer.threadId).state).not.toBe("complete");
  });
});
