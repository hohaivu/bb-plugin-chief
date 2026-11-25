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
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    expect(await world.refusal(world.complete(worker.threadId))).toContain("(docsRepair)");
    const writer = await world.delegateTo({ replaces: fix.threadId, kind: "spec-writer" });
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
    expect(await world.refusal(world.complete(worker.threadId))).toContain("(docsRepair)");
    const writer = await world.delegateTo({ replaces: worker.threadId, kind: "spec-writer" });
    expect(world.row(writer.threadId)).toMatchObject({ kind: "spec-writer", replaces_thread_id: worker.threadId });
    expect(world.row(worker.threadId).state).not.toBe("complete");
  });

  test("kind: worker replacing a ready fix run stays refused", async () => {
    const world = await gateWorld();
    const { worker } = await withFindings(world, [DOCS, CODE]);
    const fix = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(fix.threadId);
    expect(await refused(world, { replaces: fix.threadId, kind: "worker" })).toBe(`The gate already had its fix run (${fix.threadId}): escalate to the user.`);
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
  async function chatFix(world: GateWorld) {
    const { worker } = await world.passed("Fix checkout totals", { prUrl: PR });
    await world.complete(worker.threadId);
    const chat = await world.delegateTo({ replaces: worker.threadId, kind: "worker" });
    await world.ready(chat.threadId);
    return { worker, chat: chat.threadId };
  }

  test("chief_review opens a new gate task:<chat fix> and starts a reviewer; the chat fix then needs that gate to pass", async () => {
    const world = await gateWorld();
    const { worker, chat } = await chatFix(world);
    const closed = world.gate();
    const reply = await world.call("chief_review", { workerThreadId: chat }) as string;
    expect(reply).toContain("Started reviewer");
    expect(world.gate()).toMatchObject({ gate_key: `task:${chat}` });
    expect(JSON.parse(world.gate().targets).map((target: { threadId: string }) => target.threadId)).toEqual([chat]);
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
    const reviewers = () => (world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'").get() as { n: number }).n;
    const before = reviewers();
    await world.call("chief_review", { workerThreadId: chat });
    expect(reviewers()).toBe(before);
  });

  test("a finished reviewer is not reported as running: chief_review starts nothing and returns the gate's next line", async () => {
    const world = await gateWorld();
    const { chat } = await chatFix(world);
    await world.call("chief_review", { workerThreadId: chat });
    await world.verdict(world.gate().reviewer_thread_id, "approve");
    world.setIdle(world.gate().reviewer_thread_id);
    const reviewers = () => (world.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads WHERE role='reviewer'").get() as { n: number }).n;
    const before = reviewers();
    const reply = await world.call("chief_review", { workerThreadId: chat }) as string;
    expect(reply).not.toContain("already runs reviewer");
    expect(reviewers()).toBe(before);
    // The same line chief_complete's refusal shows for a gate that has not passed; here the gate passed, so complete succeeds.
    await world.complete(chat);
    expect(world.row(chat).state).toBe("complete");
  });
});
