import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { disposeAll } from "./harness";
import { type GateWorld, gateWorld } from "./gateWorld";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (the review gate always has an executable next call):
// - An unplanned gate's docs findings are repaired by a Spec Writer that replaces the gate's ready fix run, else its first target; it never completes a target.
// - A chat fix after a closed gate opens its own gate through chief_review; chief_review never claims a finished reviewer "already runs".
const DOCS = { file: "docs/specs/totals.md", line: 1, severity: "blocking", message: "Document the total." } as const;
const CODE = { file: "totals.ts", line: 4, severity: "blocking", message: "Totals go negative.", fix: "Clamp at zero" } as const;
const PR = "https://github.com/acme/shop/pull/7";
const refused = (world: GateWorld, params: object) => world.refusal(world.delegateTo(params));
/** The structured arguments of the `chief_delegate (replaces: <id>, kind: <kind>)` call a rendered gate line names. */
function renderedDelegation(line: string) {
  const call = /chief_delegate \(replaces: (\S+), kind: ([\w-]+)\)/.exec(line);
  if (!call) throw new Error(`no chief_delegate call in: ${line}`);
  return { replaces: call[1]!, kind: call[2]! };
}
const count = (world: GateWorld, where: string) => (world.state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE ${where}`).get() as { n: number }).n;
const rows = (world: GateWorld) => count(world, "1=1");

async function withFindings(world: GateWorld, findings: object[]) {
  const gated = await world.gated("Fix checkout totals", { prUrl: PR });
  await world.verdict(gated.reviewer, "request_changes", { findings });
  world.setIdle(gated.reviewer);
  return gated;
}

describe("an unplanned gate's docs repair", () => {
  test("after a fix run it replaces the ready fix run, waits for its report, then passes and both complete", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS, CODE]);
    const fixCall = renderedDelegation(await world.refusal(world.complete(worker.threadId)));
    expect(fixCall).toEqual({ replaces: worker.threadId, kind: "worker" });
    const fix = await world.delegateTo(fixCall);
    await world.ready(fix.threadId);
    const refusal = await world.refusal(world.complete(worker.threadId));
    expect(refusal).toContain("(docsRepair)");
    const repairCall = renderedDelegation(refusal);
    expect(repairCall).toEqual({ replaces: fix.threadId, kind: "spec-writer" });
    const writer = await world.delegateTo(repairCall);
    expect(world.row(writer.threadId)).toMatchObject({ kind: "spec-writer", replaces_thread_id: fix.threadId });
    expect(world.row(worker.threadId).state).not.toBe("complete");
    expect(await world.refusal(world.complete(worker.threadId))).toContain("(wait)");
    await world.ready(writer.threadId);
    await world.complete(worker.threadId);
    await world.complete(writer.threadId);
    expect(world.row(worker.threadId).state).toBe("complete");
    expect(world.row(writer.threadId).state).toBe("complete");
  });

  test("with no fix run it replaces the first target, which stays incomplete", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS]);
    const refusal = await world.refusal(world.complete(worker.threadId));
    expect(refusal).toContain("(docsRepair)");
    const repairCall = renderedDelegation(refusal);
    expect(repairCall).toEqual({ replaces: worker.threadId, kind: "spec-writer" });
    const writer = await world.delegateTo(repairCall);
    expect(world.row(writer.threadId)).toMatchObject({ kind: "spec-writer", replaces_thread_id: worker.threadId });
    expect(world.row(worker.threadId).state).not.toBe("complete");
  });

  test("kind: worker replacing a ready fix run stays refused", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS, CODE]);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    const before = rows(world);
    await refused(world, { replaces: fix.threadId, kind: "worker" });
    expect(rows(world)).toBe(before);
    expect(world.row(fix.threadId).state).not.toBe("complete");
  });

  test("a Spec Writer replacing the fix run of a code-only gate that passed is refused and changes nothing", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [CODE]);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    const before = rows(world);
    await refused(world, { replaces: fix.threadId, kind: "spec-writer" });
    expect(rows(world)).toBe(before);
    expect(world.row(fix.threadId).state).not.toBe("complete");
    expect(world.row(worker.threadId).state).not.toBe("complete");
  });

  test("a pinned target whose live thread is active still holds the branch although its row is ready", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS, CODE]);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    expect(world.row(worker.threadId).state).toBe("ready");
    world.state.live.set(worker.threadId, { ...world.state.live.get(worker.threadId)!, status: "active" });
    const before = rows(world);
    expect(await refused(world, { replaces: fix.threadId, kind: "spec-writer" })).toContain(worker.threadId);
    expect(rows(world)).toBe(before);
    world.setIdle(worker.threadId);
    const writer = await world.delegateTo({ replaces: fix.threadId, kind: "spec-writer" });
    expect(world.row(writer.threadId)).toMatchObject({ kind: "spec-writer", replaces_thread_id: fix.threadId });
  });

  test("a docs repair that reports blocked is answered in place: the gate and the writer's alert both name chief_continue on it", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS]);
    const writer = await world.delegateTo(renderedDelegation(await world.refusal(world.complete(worker.threadId))));
    await world.block(writer.threadId);
    const refusal = await world.refusal(world.complete(worker.threadId));
    expect(refusal).toContain("(escalate)");
    expect(refusal).toContain(`chief_continue (threadId: ${writer.threadId})`);
    const alert = world.state.db.prepare("SELECT message FROM alert_outbox WHERE dedupe_key LIKE ?").get(`${writer.threadId}:report:%`) as { message: string };
    expect(alert.message).toContain(`chief_continue (threadId: ${writer.threadId})`);
  });

  test("a busy branch holder still blocks it", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS]);
    const other = await world.worker("Other");
    world.state.db.prepare("UPDATE managed_threads SET branch=? WHERE thread_id=?").run(worker.branch, other.threadId);
    await world.worker("Unrelated"); // a write: the store reloads the seeded rows
    expect(await refused(world, { replaces: worker.threadId, kind: "spec-writer" })).toContain(`(${other.threadId})`);
  });
});

describe("a chat fix after a closed gate", () => {
  /** A gate that passed and completed its target, then a ready chat fix on it. */
  async function chatFix(world: GateWorld, replaces?: string) {
    const { worker } = replaces ? { worker: { threadId: replaces } } : await world.passed("Fix checkout totals", { prUrl: PR });
    if (!replaces) await world.complete(worker.threadId);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(chat.threadId);
    return { worker, chat: chat.threadId };
  }
  const reviewers = (world: GateWorld) => count(world, "role='reviewer'");
  /** The fake starts every thread idle; a running reviewer is active. */
  const running = (world: GateWorld, id: string) => world.state.live.set(id, { ...world.state.live.get(id)!, status: "active" });
  const gateRows = (world: GateWorld) => world.state.db.prepare("SELECT * FROM review_gates ORDER BY rowid").all();
  const targets = (gate: { targets: string }) => JSON.parse(gate.targets).map((target: { threadId: string }) => target.threadId);
  const pending = async (world: GateWorld) => String(await world.call("chief_roster", {}));

  test("chief_review opens a new gate task:<chat fix> and starts a reviewer; the chat fix then needs that gate to pass", async () => {
    const world = await gateWorld();
    const { worker, chat } = await chatFix(world);
    const closed = world.gate();
    const before = reviewers(world);
    await world.call("chief_review", { workerThreadId: chat });
    expect(reviewers(world)).toBe(before + 1);
    expect(world.gate()).toMatchObject({ gate_key: `task:${chat}` });
    expect(targets(world.gate())).toEqual([chat]);
    expect(world.state.db.prepare("SELECT reviewer_thread_id FROM review_gates WHERE gate_key=?").get(closed.gate_key)).toEqual({ reviewer_thread_id: closed.reviewer_thread_id });
    expect(await world.refusal(world.complete(chat))).toContain("has not passed");
    await world.verdict(world.gate().reviewer_thread_id, "approve");
    await world.complete(chat);
    expect(world.row(chat).state).toBe("complete");
    expect(world.row(worker.threadId).state).toBe("complete");
  });

  test("a second chief_review while the reviewer runs starts no second reviewer", async () => {
    const world = await gateWorld();
    const { chat } = await chatFix(world);
    await world.call("chief_review", { workerThreadId: chat });
    running(world, world.gate().reviewer_thread_id);
    const before = reviewers(world);
    await world.call("chief_review", { workerThreadId: chat });
    expect(reviewers(world)).toBe(before);
  });

  test("an idle reviewer with a verdict: chief_review starts nothing and returns the line the roster shows for the same gate state", async () => {
    const world = await gateWorld();
    const { chat } = await chatFix(world);
    await world.call("chief_review", { workerThreadId: chat });
    await world.verdict(world.gate().reviewer_thread_id, "approve");
    world.setIdle(world.gate().reviewer_thread_id);
    const before = reviewers(world);
    const gate = world.gate();
    const reply = await world.call("chief_review", { workerThreadId: chat }) as string;
    expect(reviewers(world)).toBe(before);
    expect(world.gate()).toEqual(gate);
    expect(reply.trim()).not.toBe("");
    expect(await pending(world)).toContain(reply.trim());
    await world.complete(chat);
    expect(world.row(chat).state).toBe("complete");
  });

  test("an idle reviewer with no verdict: chief_review starts nothing and returns the missing-report recovery, not the busy reply", async () => {
    const world = await gateWorld();
    const { chat } = await chatFix(world);
    await world.call("chief_review", { workerThreadId: chat });
    running(world, world.gate().reviewer_thread_id);
    const busyReply = await world.call("chief_review", { workerThreadId: chat }) as string;
    const reviewer = world.gate().reviewer_thread_id;
    const live = () => ({ ...world.state.live.get(reviewer)! });
    await world.state.harness.behavior.emitThreadEvent("thread.active", { thread: { ...live(), status: "active" } });
    world.setIdle(reviewer);
    await world.state.harness.behavior.emitThreadEvent("thread.idle", { thread: { ...live(), status: "idle" }, lastAssistantText: "I stopped" });
    const before = reviewers(world);
    const reply = await world.call("chief_review", { workerThreadId: chat }) as string;
    expect(reviewers(world)).toBe(before);
    expect(reply).not.toBe(busyReply);
    expect(reply).toContain(reviewer);
  });

  test("an unplanned target that completed with a ready code fixer is not reviewed again: refused, and the closed gate stays as it was", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [CODE]);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    await world.complete(worker.threadId);
    const gates = gateRows(world);
    const before = rows(world);
    await world.refusal(world.call("chief_review", { workerThreadId: worker.threadId }));
    expect(gateRows(world)).toEqual(gates);
    expect(rows(world)).toBe(before);
  });

  test("two chat fixes after a completed planned target: the second opens its own gate and cannot complete before it passes", async () => {
    const world = await gateWorld();
    const { worker } = await world.passed("Fix checkout totals", { prUrl: PR });
    await world.complete(worker.threadId);
    // Fixture: the target belonged to a single-wave plan, so its gate is keyed by the plan.
    world.state.db.prepare("UPDATE managed_threads SET plan_thread_id='plan_P' WHERE thread_id=?").run(worker.threadId);
    world.state.db.prepare("UPDATE review_gates SET gate_key='plan:plan_P', plan_thread_id='plan_P' WHERE gate_key=?").run(`task:${worker.threadId}`);
    const first = await chatFix(world, worker.threadId);
    await world.call("chief_review", { workerThreadId: first.chat });
    expect(world.gate()).toMatchObject({ gate_key: `task:${first.chat}` });
    await world.verdict(world.gate().reviewer_thread_id, "approve");
    await world.complete(first.chat);
    const firstGate = world.gate();
    const second = await chatFix(world, first.chat);
    await world.call("chief_review", { workerThreadId: second.chat });
    expect(world.gate()).toMatchObject({ gate_key: `task:${second.chat}` });
    expect(targets(world.gate())).toEqual([second.chat]);
    expect(world.state.db.prepare("SELECT * FROM review_gates WHERE gate_key=?").get(firstGate.gate_key)).toEqual(firstGate);
    expect(await world.refusal(world.complete(second.chat))).toContain("has not passed");
    await world.verdict(world.gate().reviewer_thread_id, "approve");
    await world.complete(second.chat);
    expect(world.row(second.chat).state).toBe("complete");
  });

  test("a chat fix that joined an open ancestor gate cannot complete while that gate has not passed", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS, CODE]);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    // Fixture: the fix run completed and the target left the branch without completing, so the gate stays open.
    world.state.db.prepare("UPDATE managed_threads SET state='complete' WHERE thread_id=?").run(fix.threadId);
    world.state.db.prepare("UPDATE managed_threads SET state='archived' WHERE thread_id=?").run(worker.threadId);
    await world.worker("Unrelated"); // a write: the store reloads the seeded rows
    const { chat } = await chatFix(world, fix.threadId);
    expect(world.state.db.prepare("SELECT 1 FROM review_gates WHERE targets LIKE ?").get(`%${chat}%`)).toBeUndefined();
    expect(await world.refusal(world.complete(chat))).toContain("has not passed");
    expect(world.row(chat).state).not.toBe("complete");
  });
});
