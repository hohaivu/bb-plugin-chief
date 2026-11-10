import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { delegate, disposeAll, setup, start, status } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// Contract (work-list spec, Contracts that stay): `chief_roster` (Pending block, `todo #N` lines, the `after:` collapse line, "Other Chiefs' todos"),
// `bb chief status` text and JSON, and `handOver`'s move of `chief_todos` and undelivered alerts equal base 310043a9b808607fbc6537c8a7672777b9c24868
// for the same state. The oracle file holds what the scenario below printed at 310043a, captured in a separate checkout of that commit with
// WORKLIST_ORACLE_OUT=<file>; this replay must match it byte for byte on head. Both sides run the same scenario through the real
// `chief_roster` tool and `bb chief status` CLI; the database rows are read back only to see what handOver moved.
// Regression: a roster/status/hand-off byte changing with the panel removal, e.g. the Pending block reading a deleted `todoItems`, a todo not moved to the successor, or an undelivered alert left on the superseded Chief.
const WORKLIST_ORACLE = join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "work-list-310043a.json");
async function workListScenario() {
  vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
  try {
    const state = await setup();
    const out: Array<{ step: string; value: unknown }> = [];
    const norm = (text: string) => text.split(state.storageRoot).join("<storage>");
    const ctx = (threadId: string) => ({ threadId, projectId: "proj_1" });
    const roster = async (threadId: string, params: object = {}) => norm(String(await state.harness.behavior.callAgentTool("chief_roster", params, ctx(threadId))));
    const cli = async (args: string[], context?: ReturnType<typeof ctx>) => {
      const result = await state.harness.behavior.runCli(["status", "--project", "proj_1", ...args], context);
      return { exitCode: result.exitCode, stdout: norm(result.stdout ?? ""), stderr: norm(result.stderr ?? "") };
    };
    const record = async (step: string, ...chiefs: string[]) => {
      for (const chief of chiefs) {
        out.push({ step: `${step}: roster of ${chief}`, value: await roster(chief) });
        out.push({ step: `${step}: roster of ${chief} with waiting and complete`, value: await roster(chief, { includeWaiting: true, includeComplete: true }) });
      }
      out.push({ step: `${step}: bb chief status`, value: await cli([]) });
      out.push({ step: `${step}: bb chief status --json`, value: await cli(["--json"]) });
    };

    const a = await start(state);
    const b = JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!) as { threadId: string };
    await record("two Chiefs, no todos", a.threadId, b.threadId);

    await roster(a.threadId, { todo: { text: "Alpha" } });
    await roster(a.threadId, { todo: { text: "Bravo", after: "user signs" } });
    await roster(a.threadId, { todo: { text: "Charlie", after: "PR #42 merges" } });
    await roster(b.threadId, { todo: { text: "Delta" } });
    await record("todos added, after: collapsed", a.threadId, b.threadId);

    await roster(a.threadId, { todo: { id: 1, text: "Alpha, renamed", after: "" } });
    await roster(a.threadId, { todo: { id: 2, state: "done" } });
    await roster(a.threadId, { todo: { id: 3, state: "dropped" } });
    await record("todos updated and closed", a.threadId, b.threadId);

    const worker = await delegate(state, a.threadId, "Fix checkout totals");
    state.failNextSend(); // the report alert stays undelivered, so the hand-off has one to move
    await state.harness.behavior.callAgentTool("chief_report", { state: "ready", result: "Ready for the successor" }, ctx(worker.threadId));
    await record("a ready worker and an undelivered alert", a.threadId, b.threadId);

    const handOffState = (step: string) => {
      out.push({ step: `${step}: chief_todos rows`, value: state.db.prepare(`SELECT id, project_id, chief_thread_id, text, after, state FROM chief_todos ORDER BY id`).all() });
      out.push({ step: `${step}: alert_outbox rows`, value: (state.db.prepare(`SELECT dedupe_key, target_thread_id, source_thread_id, delivered_at IS NOT NULL AS delivered FROM alert_outbox ORDER BY dedupe_key`).all() as any[])
        .map((row) => ({ ...row, dedupe_key: row.dedupe_key.replace(/:[0-9a-f]{16}$/, ":<hash>") })) }); // the key's tail hashes the storage path, which differs per run
      out.push({ step: `${step}: alert messages sent`, value: state.sent.map((message) => ({ threadId: message.threadId, text: norm(message.input[0].text) })) });
    };
    const archive = async (threadId: string) => {
      state.live.set(threadId, { ...state.live.get(threadId)!, archivedAt: Date.now() });
      await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(threadId)! });
      await state.supervisorCycle();
    };

    handOffState("before any hand-off");
    // Chief A ends while Chief B is live: its todos and undelivered alert move to B.
    await archive(a.threadId);
    handOffState("A archived, hand-off to B");
    await record("after the hand-off to B", b.threadId); // A is complete: only an active Chief may call chief_roster
    // Chief B ends with no other live Chief: a replacement Chief is spawned and receives them.
    await archive(b.threadId);
    const replacement = (await status(state)).threads.filter((row) => row.role === "chief" && ![a.threadId, b.threadId].includes(row.threadId)).map((row) => row.threadId);
    out.push({ step: "B archived: the replacement Chief threads", value: replacement });
    handOffState("B archived, hand-off to the replacement");
    await record("after the hand-off to the replacement", ...replacement);
    return `${JSON.stringify(out, null, 2)}\n`;
  } finally {
    vi.useRealTimers();
  }
}

describe("work list: base 310043a oracle", () => {
  test.runIf(process.env.WORKLIST_ORACLE_OUT)("capture the oracle (run at 310043a)", async () => {
    await writeFile(process.env.WORKLIST_ORACLE_OUT!, await workListScenario());
  });

  test.skipIf(process.env.WORKLIST_ORACLE_OUT)("roster, bb chief status and the hand-off equal base on the same scenario", async () => {
    expect(await workListScenario()).toBe(await readFile(WORKLIST_ORACLE, "utf8"));
  });
});
