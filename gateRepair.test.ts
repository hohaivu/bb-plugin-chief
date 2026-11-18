import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { PLAN_FIXTURE, disposeAll } from "./test/harness";
import { type GateWorld, gateWorld } from "./test/gateWorld";
import { delegateWave, plan } from "./test/testerHelpers";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (the gate's repair runs, src/runtime/delegation.ts fixAdmission): with the gate in `fix`, the gate's one fix run F is chief_delegate
// (replaces: <tester>, kind: worker); a corrector (replaces: F, kind: tester) exists only after F reports blocked, once; neither is replaced again.
// A gate's target cannot be replaced while the gate is open. After completion a change is a chat fix (fix_run 'chat', no gate, no old findings).
const refused = (world: GateWorld, params: object) => world.refusal(world.delegateTo(params));

/** A gate in `fix`: the reviewer approved and the tester's tests are red. */
async function inFix(world: GateWorld) {
  const gated = await world.gated();
  await world.verdict(gated.reviewer, "approve");
  await world.testReport(gated.tester, false);
  return gated;
}
/** F that reported blocked with wrong-test evidence: the gate wants its one corrector. */
async function inWrongTest(world: GateWorld) {
  const gated = await inFix(world);
  const fix = await world.delegateTo({ replaces: gated.tester, kind: "worker" });
  await world.block(fix.threadId, "totals.test.ts:12 contradicts the plan.");
  return { ...gated, fix: fix.threadId };
}

test("a stopped fix run without a report is replaced in its own environment", async () => {
  const world = await gateWorld();
  const { tester } = await inFix(world);
  const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
  const environment = world.state.live.get(fix.threadId)!.environmentId;
  world.state.live.set(fix.threadId, { ...world.state.live.get(fix.threadId)!, status: "active" });
  await world.call("chief_stop", { threadId: fix.threadId });
  expect(await refused(world, { replaces: tester, kind: "worker" })).toContain(`replaces: ${fix.threadId}, kind: worker`);
  const next = await world.delegateTo({ replaces: fix.threadId, kind: "worker" });
  expect(world.gate().fixer_thread_id).toBe(next.threadId);
  expect(world.row(fix.threadId).state).toBe("complete");
  expect(world.state.live.get(next.threadId)!.environmentId).toBe(environment);
});

test("a green fix permits one advisory re-review even if it also requests changes", async () => {
  const world = await gateWorld();
  const { worker, reviewer, tester } = await world.gated();
  await world.verdict(reviewer, "request_changes");
  await world.testReport(tester, true);
  const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
  await world.ready(fix.threadId, { testsPassed: true });
  await world.open(worker.threadId);
  const second = world.gate().reviewer_thread_id;
  expect(second).not.toBe(reviewer);
  await world.open(worker.threadId);
  expect(world.gate().reviewer_thread_id).toBe(second);
  await world.verdict(second, "request_changes");
  await world.open(worker.threadId);
  expect(world.gate().reviewer_thread_id).toBe(second);
  await world.complete(fix.threadId);
  expect(world.row(fix.threadId).state).toBe("complete");
});

describe("the gate's one fix run", () => {
  test("the first replaces: <tester>, kind: worker is admitted, and reuses the tester's environment", async () => {
    const world = await gateWorld();
    const { reviewer, tester } = await inFix(world);
    const testerEnvironment = world.state.live.get(tester)!.environmentId;
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    expect(world.row(fix.threadId)).toMatchObject({ role: "worker", kind: null, replaces_thread_id: tester, fix_run: "gate" });
    expect(world.state.live.get(fix.threadId)!.environmentId).toBe(testerEnvironment);
    expect(world.gate().fixer_thread_id).toBe(fix.threadId);
    expect(world.gate().reviewer_thread_id).toBe(reviewer);
  });

  test("a second one is refused: the gate already had its fix run", async () => {
    const world = await gateWorld();
    const { tester } = await inFix(world);
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    expect(await refused(world, { replaces: tester, kind: "worker" })).toBe(`The gate already had its fix run (${fix.threadId}): escalate to the user.`);
  });

  test("replaces: <tester> without a kind is refused, naming the kinds", async () => {
    const world = await gateWorld();
    const { tester } = await inFix(world);
    expect(await refused(world, { replaces: tester })).toContain("Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs/.");
    expect(world.gate().fixer_thread_id).toBeNull();
  });

  test("replaces: <tester> with kind: tester is refused: only the gate's fix run replaces it", async () => {
    const world = await gateWorld();
    const { tester } = await inFix(world);
    expect(await refused(world, { replaces: tester, kind: "tester" })).toContain("only the gate's one fix run replaces it");
  });

  test("a gate that needs no fix refuses a fix run, and says what it wants instead", async () => {
    const world = await gateWorld();
    const { worker, reviewer, tester } = await world.passed();
    const message = await refused(world, { replaces: tester, kind: "worker" });
    expect(message).toContain("needs no fix run");
    expect(message).toContain(`chief_complete (threadId: ${worker.threadId}`);
    expect(reviewer).toBeTruthy();
  });

  test("replaces: a gate target is refused while the gate is open: fixes go through the gate's fix run", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    for (const kind of ["worker", "tester"]) {
      expect(await refused(world, { replaces: worker.threadId, kind })).toContain(`The review gate pinned ${worker.threadId}; fixes go through the gate's fix run.`);
    }
  });

  test("the gate's fix run is admitted while its target is still active on the same branch", async () => {
    const world = await gateWorld();
    const gated = await world.gated();
    await world.verdict(gated.reviewer, "approve");
    await world.testReport(gated.tester, false);
    const fix = await world.delegateTo({ replaces: gated.tester, kind: "worker" });
    expect(world.gate().fixer_thread_id).toBe(fix.threadId);
  });
});

describe("the gate's one corrector", () => {
  test("is admitted once F reported blocked, and reuses F's environment", async () => {
    const world = await gateWorld();
    const { fix } = await inWrongTest(world);
    const fixEnvironment = world.state.live.get(fix)!.environmentId;
    const corrector = await world.delegateTo({ replaces: fix, kind: "tester" });
    expect(world.row(corrector.threadId)).toMatchObject({ role: "worker", kind: "tester", replaces_thread_id: fix });
    expect(world.state.live.get(corrector.threadId)!.environmentId).toBe(fixEnvironment);
    expect(world.gate().corrector_thread_id).toBe(corrector.threadId);
  });

  test("is refused while F has not reported blocked", async () => {
    const world = await gateWorld();
    const { tester } = await inFix(world);
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    await world.ready(fix.threadId, { testsPassed: true });
    expect(await refused(world, { replaces: fix.threadId, kind: "tester" })).toContain("only after it reports blocked with wrong-test evidence");
    expect(world.gate().corrector_thread_id).toBeNull();
  });

  test("is admitted only once: a second corrector is refused", async () => {
    const world = await gateWorld();
    const { fix } = await inWrongTest(world);
    const corrector = await world.delegateTo({ replaces: fix, kind: "tester" });
    await world.testReport(corrector.threadId, false);
    const before = world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get();
    await refused(world, { replaces: fix, kind: "tester" });
    expect(world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get()).toEqual(before);
    expect(world.gate().corrector_thread_id).toBe(corrector.threadId);
  });

  test("a second corrector's refusal says the gate already had its corrector", async () => {
    const world = await gateWorld();
    const { fix } = await inWrongTest(world);
    const corrector = await world.delegateTo({ replaces: fix, kind: "tester" });
    await world.testReport(corrector.threadId, false);
    expect(await refused(world, { replaces: fix, kind: "tester" })).toContain("already had its corrector");
  });

  test("is never replaced: there is no second fix", async () => {
    const world = await gateWorld();
    const { fix } = await inWrongTest(world);
    const corrector = await world.delegateTo({ replaces: fix, kind: "tester" });
    await world.testReport(corrector.threadId, false);
    for (const kind of ["worker", "tester"]) {
      expect(await refused(world, { replaces: corrector.threadId, kind })).toContain("there is no second fix. Escalate to the user.");
    }
  });

  test("after the corrector ended red, no second fix worker is admitted, through the tester, F or the target", async () => {
    const world = await gateWorld();
    const { worker, tester, fix } = await inWrongTest(world);
    const corrector = await world.delegateTo({ replaces: fix, kind: "tester" });
    await world.testReport(corrector.threadId, false);
    const before = world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get();
    await refused(world, { replaces: tester, kind: "worker" });
    await refused(world, { replaces: fix, kind: "worker" });
    await refused(world, { replaces: worker.threadId, kind: "worker" });
    expect(world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get()).toEqual(before);
  });
});

describe("kind: tester while the gate is open", () => {
  test("is refused unless evidenceOnly: the gate's one tester writes the tests", async () => {
    const world = await gateWorld();
    const planner = await plan(world.state, world.chief, [{ body: PLAN_FIXTURE }]);
    const branch = "feature/plan-gate";
    world.git.remote.set(branch, "a".repeat(40));
    await delegateWave(world.state, world.chief, planner.threadId, 1, { branch });
    const worker = world.state.db.prepare(`SELECT thread_id FROM managed_threads WHERE plan_thread_id=? AND role='worker'`).get(planner.threadId) as { thread_id: string };
    await world.ready(worker.thread_id);
    await world.open(worker.thread_id);
    const message = await world.refusal(world.call("chief_delegate", { title: "More tests", mission: "Add tests.", planThreadId: planner.threadId, wave: 1, kind: "tester" }));
    expect(message).toContain("is open: its one tester writes the tests. Pass evidenceOnly");
  });
});

test("a ready green fixer no longer holds the branch against a Spec Writer", async () => {
  const world = await gateWorld();
  const { worker, reviewer, tester } = await world.gated();
  await world.verdict(reviewer, "request_changes", {
    findings: [{ file: "docs/specs/totals.md", line: 1, severity: "blocking", message: "Document the total." }],
  });
  await world.testReport(tester, false);
  const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
  await world.ready(fix.threadId, { testsPassed: true });
  const writer = await world.delegateTo({ replaces: worker.threadId, kind: "spec-writer" });
  expect(world.row(writer.threadId)).toMatchObject({ kind: "spec-writer", branch: worker.branch });
  expect(world.row(fix.threadId).state).toBe("ready");
});

describe("a docs repair while the gate's writable run is busy", () => {
  test("is refused while the fix run is working, and says to wait for its report", async () => {
    const world = await gateWorld();
    const { worker, tester } = await inFix(world);
    const fix = await world.delegateTo({ replaces: tester, kind: "worker" });
    const message = await refused(world, { replaces: worker.threadId, kind: "spec-writer" });
    expect(message).toContain(`fix run ${fix.threadId} is still working on the branch: wait for its report, then repair the docs.`);
  });

  test("is refused while the corrector is working", async () => {
    const world = await gateWorld();
    const { worker, fix } = await inWrongTest(world);
    const corrector = await world.delegateTo({ replaces: fix, kind: "tester" });
    const message = await refused(world, { replaces: worker.threadId, kind: "spec-writer" });
    expect(message).toContain(`corrector ${corrector.threadId} is still working on the branch: wait for its report, then repair the docs.`);
  });
});

describe("a chat fix: a change after completion", () => {
  /** A worker whose gate passed on a fix run's green report (so the gate's findings exist), complete, PR open. */
  async function completed(world: GateWorld) {
    const gated = await world.gated("Fix checkout totals", { prUrl: PR });
    await world.verdict(gated.reviewer, "request_changes");
    await world.testReport(gated.tester, true);
    const fix = await world.delegateTo({ replaces: gated.tester, kind: "worker" });
    await world.ready(fix.threadId, { testsPassed: true });
    await world.complete(gated.worker.threadId);
    return { ...gated, fix: fix.threadId };
  }
  const PR = "https://github.com/acme/shop/pull/7";

  test("replaces: a completed target is admitted: fix_run 'chat', in the target's environment, with no old findings", async () => {
    const world = await gateWorld();
    const { worker } = await completed(world);
    const environment = world.state.live.get(worker.threadId)!.environmentId;
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    expect(world.row(chat.threadId)).toMatchObject({ role: "worker", replaces_thread_id: worker.threadId, fix_run: "chat" });
    expect(world.state.live.get(chat.threadId)!.environmentId).toBe(environment);
    const prompt = world.state.spawned.at(-1)!.prompt as string;
    expect(prompt).not.toContain("Totals go negative.");
    expect(world.gate().fixer_thread_id).not.toBe(chat.threadId);
  });

  test("without kind: worker it is refused, naming the route", async () => {
    const world = await gateWorld();
    const { worker } = await completed(world);
    expect(await refused(world, { replaces: worker.threadId })).toContain(`A change after completion is a fix run: chief_delegate (replaces: ${worker.threadId}, kind: worker).`);
  });

  test("after the PR is merged and cleaned up, the target's thread is archived and a chat fix is refused", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker } = await completed(world);
    world.state.harness.sdk.stub("threads.childSummary", async () => ({ unarchivedDescendantCount: 0 }));
    world.state.harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => {
      world.state.live.set(threadId, { ...world.state.live.get(threadId)!, archivedAt: Date.now() } as any);
      return { ok: true, archivedThreadIds: [threadId] };
    });
    world.git.prStates.set(PR, "MERGED");
    await world.state.supervisorCycle();
    expect(world.state.live.get(worker.threadId)!.archivedAt).not.toBeNull();
    expect(await refused(world, { replaces: worker.threadId, kind: "worker" })).toContain("is not replaceable");
  });

  test("completes on a ready report with tests_passed=1, and stamps cleanup_approved_at when cleanup is active", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker } = await completed(world);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(chat.threadId, { testsPassed: true });
    await world.complete(chat.threadId);
    expect(world.row(chat.threadId)).toMatchObject({ state: "complete", tests_passed: 1 });
    expect(world.row(chat.threadId).cleanup_approved_at).not.toBeNull();
  });

  test("with cleanup off it completes and stamps nothing", async () => {
    const world = await gateWorld({ cleanup: false });
    const { worker } = await completed(world);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(chat.threadId, { testsPassed: true });
    await world.complete(chat.threadId);
    expect(world.row(chat.threadId)).toMatchObject({ state: "complete", cleanup_approved_at: null });
  });

  test("a chat fix with no green ready report is refused completion, and needs no gate", async () => {
    const world = await gateWorld();
    const { worker } = await completed(world);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    world.setIdle(chat.threadId);
    const message = await world.refusal(world.complete(chat.threadId));
    expect(message).toContain("has no green ready report");
    expect(message).not.toContain("review gate");
  });
});
