import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { disposeAll } from "./test/harness";
import { type GateWorld, gateWorld } from "./test/gateWorld";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (the gate's repair runs, src/runtime/delegation.ts fixAdmission): with the gate in `fix`, the gate's one fix run F is chief_delegate
// (replaces: <the gate's first target>, kind: worker). The target stays live until the gate passes; F is not replaced again once it reported.
// After completion a change is a chat fix (fix_run 'chat', no gate, no old findings).
const refused = (world: GateWorld, params: object) => world.refusal(world.delegateTo(params));

/** A gate in `fix`: the reviewer requested changes with a blocking code finding. */
async function inFix(world: GateWorld) {
  const gated = await world.gated();
  await world.verdict(gated.reviewer, "request_changes");
  world.setIdle(gated.reviewer);
  return gated;
}

test("a stopped fix run without a report is replaced in its own environment", async () => {
  const world = await gateWorld();
  const { worker } = await inFix(world);
  const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
  const environment = world.state.live.get(fix.threadId)!.environmentId;
  world.state.live.set(fix.threadId, { ...world.state.live.get(fix.threadId)!, status: "active" });
  await world.call("chief_stop", { threadId: fix.threadId });
  expect(await refused(world, { replaces: worker.threadId, kind: "worker" })).toContain(`replaces: ${fix.threadId}, kind: worker`);
  const next = await world.delegateTo({ replaces: fix.threadId, kind: "worker" });
  expect(world.gate().fixer_thread_id).toBe(next.threadId);
  expect(world.row(fix.threadId).state).toBe("complete");
  expect(world.state.live.get(next.threadId)!.environmentId).toBe(environment);
});

test("a ready fix permits one advisory re-review even if it also requests changes", async () => {
  const world = await gateWorld();
  const { worker, reviewer } = await inFix(world);
  const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
  await world.ready(fix.threadId);
  await world.open(worker.threadId);
  const second = world.gate().reviewer_thread_id;
  expect(second).not.toBe(reviewer);
  await world.open(worker.threadId);
  expect(world.gate().reviewer_thread_id).toBe(second);
  await world.verdict(second, "request_changes");
  await world.open(worker.threadId);
  expect(world.gate().reviewer_thread_id).toBe(second);
  await world.complete(worker.threadId);
  expect(world.row(worker.threadId).state).toBe("complete");
});

describe("the gate's one fix run", () => {
  test("replaces: <first target>, kind: worker is admitted in the target's environment, and the target stays live", async () => {
    const world = await gateWorld();
    const { worker, reviewer } = await inFix(world);
    const targetEnvironment = world.state.live.get(worker.threadId)!.environmentId;
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    expect(world.row(fix.threadId)).toMatchObject({ role: "worker", kind: null, replaces_thread_id: worker.threadId, fix_run: "gate" });
    expect(world.state.live.get(fix.threadId)!.environmentId).toBe(targetEnvironment);
    expect(world.gate().fixer_thread_id).toBe(fix.threadId);
    expect(world.gate().reviewer_thread_id).toBe(reviewer);
    expect(world.row(worker.threadId).state).not.toBe("complete");
  });

  test("a second one is refused: the gate already had its fix run", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    expect(await refused(world, { replaces: worker.threadId, kind: "worker" })).toBe(`The gate already had its fix run (${fix.threadId}): escalate to the user.`);
    expect(await refused(world, { replaces: fix.threadId, kind: "worker" })).toBe(`The gate already had its fix run (${fix.threadId}): escalate to the user.`);
  });

  test("replaces: <first target> without kind: worker is refused, naming the fix-run route", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    expect(await refused(world, { replaces: worker.threadId })).toContain(`one fix run replaces its first target: chief_delegate (replaces: ${worker.threadId}, kind: worker)`);
    expect(world.gate().fixer_thread_id).toBeNull();
  });

  test("a gate that needs no fix refuses a fix run, and says what it wants instead", async () => {
    const world = await gateWorld();
    const { worker } = await world.passed();
    const message = await refused(world, { replaces: worker.threadId, kind: "worker" });
    expect(message).toContain("needs no fix run");
    expect(message).toContain(`chief_complete (threadId: ${worker.threadId}`);
  });

  test("a blocked fix run is answered in place, never replaced by a second fix", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.block(fix.threadId, "The totals contract contradicts the plan.");
    const before = world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get();
    expect(await refused(world, { replaces: fix.threadId, kind: "worker" })).toContain("escalate to the user");
    expect(await refused(world, { replaces: worker.threadId, kind: "worker" })).toContain("escalate to the user");
    expect(world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get()).toEqual(before);
  });
});

test("a ready fixer no longer holds the branch against a Spec Writer", async () => {
  const world = await gateWorld();
  const { worker, reviewer } = await world.gated();
  await world.verdict(reviewer, "request_changes", {
    findings: [
      { file: "docs/specs/totals.md", line: 1, severity: "blocking", message: "Document the total." },
      { file: "totals.ts", line: 4, severity: "blocking", message: "Totals go negative.", fix: "Clamp at zero" },
    ],
  });
  world.setIdle(reviewer);
  const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
  await world.ready(fix.threadId);
  const writer = await world.delegateTo({ replaces: worker.threadId, kind: "spec-writer" });
  expect(world.row(writer.threadId)).toMatchObject({ kind: "spec-writer", branch: worker.branch });
  expect(world.row(fix.threadId).state).toBe("ready");
});

describe("a docs repair while the gate's fix run is busy", () => {
  test("is refused while the fix run is working, and says to wait for its report", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    const message = await refused(world, { replaces: worker.threadId, kind: "spec-writer" });
    expect(message).toContain(`fix run ${fix.threadId} is still working on the branch: wait for its report, then repair the docs.`);
  });
});

describe("a chat fix: a change after completion", () => {
  /** A worker whose gate passed on a fix run's ready report (so the gate's findings exist), complete, PR open. */
  async function completed(world: GateWorld) {
    const gated = await world.gated("Fix checkout totals", { prUrl: PR });
    await world.verdict(gated.reviewer, "request_changes");
    world.setIdle(gated.reviewer);
    const fix = await world.delegateTo({ replaces: gated.worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
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

  test("completes on a ready report, and stamps cleanup_approved_at when cleanup is active", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker } = await completed(world);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(chat.threadId);
    await world.complete(chat.threadId);
    expect(world.row(chat.threadId)).toMatchObject({ state: "complete" });
    expect(world.row(chat.threadId).cleanup_approved_at).not.toBeNull();
  });

  test("with cleanup off it completes and stamps nothing", async () => {
    const world = await gateWorld({ cleanup: false });
    const { worker } = await completed(world);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(chat.threadId);
    await world.complete(chat.threadId);
    expect(world.row(chat.threadId)).toMatchObject({ state: "complete", cleanup_approved_at: null });
  });

  test("a chat fix with no ready report is refused completion, and needs no gate", async () => {
    const world = await gateWorld();
    const { worker } = await completed(world);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    world.setIdle(chat.threadId);
    const message = await world.refusal(world.complete(chat.threadId));
    expect(message).toContain("has no ready report yet");
    expect(message).not.toContain("review gate");
  });
});

describe("a gate fix run on a legacy gate", () => {
  test("a ready legacy tester on the first target's branch does not hold the branch for the fix run", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    const targetEnvironment = world.state.live.get(worker.threadId)!.environmentId;
    const tester = await world.worker("Legacy tester");
    world.state.db.prepare("UPDATE managed_threads SET branch=?, kind='tester' WHERE thread_id=?").run(worker.branch, tester.threadId);
    world.state.db.prepare("UPDATE review_gates SET tester_thread_id=? WHERE gate_key=?").run(tester.threadId, world.gate().gate_key);
    await world.ready(tester.threadId); // a write: the store reloads the seeded rows
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    expect(world.gate().fixer_thread_id).toBe(fix.threadId);
    expect(world.state.live.get(fix.threadId)!.environmentId).toBe(targetEnvironment);
  });

  test("a working legacy tester on the branch still holds it", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    const tester = await world.worker("Legacy tester");
    world.state.db.prepare("UPDATE review_gates SET tester_thread_id=? WHERE gate_key=?").run(tester.threadId, world.gate().gate_key);
    world.state.db.prepare("UPDATE managed_threads SET branch=?, kind='tester' WHERE thread_id=?").run(worker.branch, tester.threadId);
    await world.worker("Unrelated"); // a write: the store reloads the seeded rows
    expect(await refused(world, { replaces: worker.threadId, kind: "worker" })).toContain(`(${tester.threadId})`);
  });

  test("a legacy tester resumed after a blocked report still holds the branch", async () => {
    const world = await gateWorld();
    const { worker } = await inFix(world);
    const tester = await world.worker("Legacy tester");
    world.state.db.prepare("UPDATE review_gates SET tester_thread_id=? WHERE gate_key=?").run(tester.threadId, world.gate().gate_key);
    world.state.db.prepare("UPDATE managed_threads SET branch=?, kind='tester', state='active', last_report_state='blocked' WHERE thread_id=?").run(worker.branch, tester.threadId);
    await world.worker("Unrelated"); // a write: the store reloads the seeded rows
    expect(await refused(world, { replaces: worker.threadId, kind: "worker" })).toContain(`(${tester.threadId})`);
  });
});

test("replacing a gate's second target names the gate's first target", async () => {
  const world = await gateWorld();
  const { worker } = await world.gated();
  const second = await world.worker("Second target");
  const gate = world.gate();
  const targets = JSON.parse(gate.targets);
  world.state.db.prepare("UPDATE review_gates SET targets=? WHERE gate_key=?").run(JSON.stringify([...targets, { ...targets[0], threadId: second.threadId }]), gate.gate_key);
  await world.ready(second.threadId);
  const message = await refused(world, { replaces: second.threadId, kind: "worker" });
  expect(message).toContain(worker.threadId);
});
