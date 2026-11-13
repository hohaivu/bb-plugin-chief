import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { CLOSE_OUT, delegate, execFileMock, start, type setup } from "./harness";
import { plan, report, setLive } from "./testerHelpers";

type State = Awaited<ReturnType<typeof setup>>;

/** Routes `bb workflows <sub> …` to stubs; any other child process (git, gh) answers empty. No real process or network runs. */
export function workflowStubs() {
  const stubs = { run: vi.fn(async (_args: string[]): Promise<unknown> => ({ runId: "wfr_1" })), status: vi.fn(async (_args: string[]): Promise<unknown> => ({ status: "running" })), stop: vi.fn(async (_args: string[]): Promise<unknown> => ({ ok: true })), history: vi.fn(async (_args: string[]): Promise<unknown> => []) };
  execFileMock.mockImplementation(async (_file: string, args: string[]) => {
    if (args[0] !== "workflows") return { stdout: "", stderr: "" };
    return { stdout: JSON.stringify(await (stubs as any)[args[1]!](args.slice(2).filter((arg) => arg !== "--json"))), stderr: "" };
  });
  return stubs;
}

export const ev = (seq: number, item: Record<string, unknown>, createdAt = Date.now()) => ({ type: "item/completed", seq, createdAt, data: { item } });
export const userSays = (seq: number, text: string, createdAt?: number) => ev(seq, { type: "userMessage", content: [{ type: "text", text }] }, createdAt);
export const blockedReport = (seq: number, question: string) => ev(seq, { type: "toolCall", tool: "chief_report", status: "completed", arguments: { state: "blocked", result: question }, result: "ok" });

/** Chief, a one-wave plan whose planner is complete, and one complete worker on it. Seeds the rows the way a finished plan leaves them. */
export async function completedPlan(state: State, options: { mission?: string; before?: (ids: { chief: string; planner: string; worker: string }) => void | Promise<void> } = {}) {
  // The fake host has no files.read: read from the temp storage root the fake files.write wrote to.
  state.harness.sdk.stub("files.read", async ({ path }: { path: string }) => ({ content: await readFile(path, "utf8") }));
  await state.harness.behavior.setSettings({ retroJudge: true });
  const chief = (await start(state)).threadId;
  const planner = (await plan(state, chief)).threadId;
  const spawned = await state.harness.behavior.runCli(["delegate", "--title", "Fix totals", "--mission", options.mission ?? "Correct and verify totals", "--criteria", "Regression passes", "--unplanned-reason", "Bounded test fixture", "--json"], { threadId: chief, projectId: "proj_1" });
  const worker = (JSON.parse(spawned.stdout!) as { threadId: string }).threadId;
  setLive(state, worker, "idle");
  await report(state, worker, { state: "ready", result: "Done.\n\n## Deviations from plan\nNone" });
  await state.harness.behavior.callAgentTool("chief_complete", { threadId: worker, ...CLOSE_OUT }, { threadId: chief, projectId: "proj_1" });
  state.db.prepare(`UPDATE managed_threads SET plan_thread_id=?, plan_wave=1, unplanned_reason=NULL WHERE thread_id=?`).run(planner, worker);
  state.db.prepare(`UPDATE managed_threads SET state='complete', updated_at=? WHERE thread_id=?`).run(Date.now() + 1_000, planner);
  await options.before?.({ chief, planner, worker });
  // The thread store reloads its row cache on its next write: an unrelated delegate is that write.
  await delegate(state, chief, "Reload trigger");
  return { chief, planner, worker, tick: () => state.harness.behavior.runSchedule("retro") };
}

export const retroRow = (state: State, planner: string) => state.db.prepare(`SELECT * FROM chief_retros WHERE plan_thread_id=?`).get(planner) as any;
export const dueNow = (state: State, planner: string) => state.db.prepare(`UPDATE chief_retros SET next_at=0 WHERE plan_thread_id=?`).run(planner);
