import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { configurationContext, delegate, disposeAll, setup, start, status } from "./test/harness";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (docs/decisions/2026-11-13-lesson-lifecycle-gate.md, docs/specs/observability.md "Lesson lifecycle"):
// a lesson reaches a prompt only once accepted; accept and retire go through `bb chief lesson` with a reason and a legal transition;
// rows that predate the gate keep their injection; a role='chief' lesson reaches Chief after its rules.
type State = Awaited<ReturnType<typeof setup>>;
const as = (threadId: string, projectId = "proj_1") => ({ threadId, projectId });
const instructionsOf = async (state: State, threadId: string, projectId = "proj_1", pluginMetadata?: object) =>
  (await state.harness.behavior.resolveAgentConfiguration({ ...configurationContext(threadId, projectId), ...(pluginMetadata ? { pluginMetadata } : {}) })).instructions as string;
const lesson = (state: State, chief: string, action: string, id: number, reason: string | null = "because") =>
  state.harness.behavior.runCli(["lesson", action, String(id), ...(reason === null ? [] : ["--reason", reason]), "--json"], as(chief));
const statusOf = (state: State, id: number) => (state.db.prepare(`SELECT status FROM chief_lessons WHERE id=?`).get(id) as { status: string }).status;

async function withReport(role: "advisor" | "reviewer", text: string) {
  const state = await setup();
  const chief = (await start(state)).threadId;
  const worker = (await delegate(state, chief)).threadId;
  await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for review" }, as(worker));
  if (role === "reviewer") {
    await state.harness.behavior.callAgentTool("chief_review", { workerThreadId: worker }, as(chief));
    const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!.threadId;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Reviewed", verdict: "approve", findings: [], lesson: text }, as(reviewer));
  } else {
    await state.harness.behavior.runCli(["consult", "--title", "Rework", "--mission", "Explore"], as(chief));
    const advisor = (await status(state)).threads.find((row) => row.role === "advisor")!.threadId;
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Done", lesson: text }, as(advisor));
  }
  const id = (state.db.prepare(`SELECT id FROM chief_lessons ORDER BY id DESC`).get() as { id: number }).id;
  const reviewerSeed = { role: "reviewer", chiefThreadId: chief };
  return { state, chief, id, worker, seen: (seed: string) => instructionsOf(state, `thr_seed_${seed}`, "proj_1", seed === "reviewer" ? reviewerSeed : { role: seed, chiefThreadId: chief }) };
}

describe("lesson gate", () => {
  test.each(["advisor", "reviewer"] as const)("a %s's report lesson is stored proposed and reaches no prompt; accept injects it, retire removes it", async (role) => {
    const text = `A ${role} lesson about discounts.`;
    const { state, chief, id, seen } = await withReport(role, text);
    expect(statusOf(state, id)).toBe("proposed");
    expect(await seen("reviewer")).not.toContain(text);
    expect(await seen("worker")).not.toContain(text);

    const accepted = await lesson(state, chief, "accept", id, "worth keeping");
    expect(accepted.exitCode).toBe(0);
    expect(statusOf(state, id)).toBe("accepted");
    expect(state.db.prepare(`SELECT decided_reason FROM chief_lessons WHERE id=?`).get(id)).toEqual({ decided_reason: "worth keeping" });
    expect(await seen("reviewer")).toContain(text);
    // An advisor lesson reaches every managed role; a reviewer lesson reaches reviewers only.
    expect((await seen("worker")).includes(text)).toBe(role === "advisor");
    expect((await seen("planner")).includes(text)).toBe(role === "advisor");

    expect((await lesson(state, chief, "retire", id, "outdated")).exitCode).toBe(0);
    expect(statusOf(state, id)).toBe("retired");
    expect(await seen("reviewer")).not.toContain(text);
    expect(await seen("worker")).not.toContain(text);
  });

  test("a lesson row that predates the gate (no status written) is accepted and still injected", async () => {
    const { state, seen } = await withReport("advisor", "unused");
    state.db.prepare(`INSERT INTO chief_lessons (project_id, text, source_thread_id, worker_thread_id, at, role) VALUES ('proj_1', 'An older lesson.', 'thr_old', NULL, 1, NULL)`).run();
    expect(state.db.prepare(`SELECT status FROM chief_lessons WHERE text='An older lesson.'`).get()).toEqual({ status: "accepted" });
    expect(await seen("worker")).toContain("- An older lesson.");
  });

  test("a role='chief' lesson reaches Chief only after it is accepted, and after Chief's rules", async () => {
    const state = await setup({ rules: "Always ship small pull requests." });
    const chief = (await start(state)).threadId;
    state.db.prepare(`INSERT INTO chief_lessons (project_id, text, source_thread_id, worker_thread_id, at, role, status) VALUES ('proj_1', 'Pass the user constraints on in the brief.', 'thr_plan', NULL, 5, 'chief', 'proposed')`).run();
    expect(await instructionsOf(state, chief)).not.toContain("Pass the user constraints on in the brief.");
    expect((await lesson(state, chief, "accept", 1)).exitCode).toBe(0);
    const text = await instructionsOf(state, chief);
    expect(text).toContain("## Chief lessons (communication)\n- Pass the user constraints on in the brief.");
    expect(text.indexOf("Pass the user constraints")).toBeGreaterThan(text.indexOf("Always ship small pull requests."));
    // Chief lessons never leak to a worker's prompt.
    expect(await instructionsOf(state, "thr_seed_worker", "proj_1", { role: "worker", chiefThreadId: chief })).not.toContain("Pass the user constraints");
  });

  test.each([
    ["accept an accepted lesson", "accept", "accepted", "because", /is accepted/],
    ["retire a retired lesson", "retire", "retired", "because", /already retired/],
    ["accept a retired lesson", "accept", "retired", "because", /is retired/],
    ["accept without a reason", "accept", "proposed", null, /requires --reason/],
    ["accept an unknown lesson", "accept", null, "because", /No lesson/],
  ])("an invalid transition exits non-zero and changes nothing: %s", async (_name, action, from, reason, message) => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    if (from) state.db.prepare(`INSERT INTO chief_lessons (project_id, text, source_thread_id, at, status) VALUES ('proj_1', 'x', 't', 1, ?)`).run(from);
    const result = await lesson(state, chief, action, from ? 1 : 77, reason);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(message);
    if (from) expect(statusOf(state, 1)).toBe(from);
  });
});
