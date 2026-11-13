import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { RESEARCH_SCRIPTS } from "./server";
import { disposeAll, execFileMock, setup, start, status } from "./test/harness";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contract (wave 3, "Runner move"): extracting `bb workflows` execution out of research.ts into src/research/workflowCli.ts keeps its full argv,
// controlled env, timeout, buffer and error mapping. The same fixtures ran against the pre-extraction base (8b3a32e) and the head;
// set WF_CLI_TRANSCRIPT=<file> to dump what was observed, so two trees can be diffed byte for byte.
const TABLE = "| Item | Finding | Evidence |";
const transcript: Record<string, unknown> = {};

async function planner(state: Awaited<ReturnType<typeof setup>>) {
  await state.harness.behavior.setSettings({ plannerEnabled: true });
  const chief = await start(state);
  await state.harness.behavior.runCli(["plan", "--title", "Rework", "--mission", "Propose"], { threadId: chief.threadId, projectId: "proj_1" });
  return (await status(state)).threads.find((row) => row.role === "planner")!.threadId;
}
const research = (state: Awaited<ReturnType<typeof setup>>, threadId: string, params: unknown) =>
  state.harness.behavior.callAgentTool("chief_research", params, { threadId, projectId: "proj_1" }) as Promise<string>;
const workflowCalls = () => execFileMock.mock.calls.filter((call) => call[1][0] === "workflows");

describe("runWorkflowCli: the same fixtures against the pre-extraction base and the head", () => {
  test.each([
    ["survey", { mode: "survey", question: "Who calls this?", items: ["a.ts"] }],
    ["investigate", { mode: "investigate", question: "Why?", questions: ["a"] }],
  ])("%s: run, status and history are launched with the full argv, the controlled env, a 30 s timeout and a 16 MiB buffer", async (mode, params) => {
    const state = await setup();
    const threadId = await planner(state);
    const processEnvAtCall: NodeJS.ProcessEnv[] = [];
    execFileMock.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === "workflows") processEnvAtCall.push({ ...process.env });
      if (args[1] === "run") return { stdout: JSON.stringify({ runId: "wfr_1" }), stderr: "" };
      if (args[1] === "status") return { stdout: JSON.stringify({ status: "succeeded", resultOmitted: true }), stderr: "" };
      return { stdout: [{ type: "run", result: { table: TABLE } }, { type: "page", nextCursor: null }].map((record) => JSON.stringify(record)).join("\n") + "\n", stderr: "" };
    });
    expect(await research(state, threadId, params)).toContain(TABLE);

    const seen = workflowCalls().map(([file, args, options], index) => ({
      file, args, timeout: options.timeout, maxBuffer: options.maxBuffer,
      env: { PATH: options.env.PATH, BB_THREAD_ID: options.env.BB_THREAD_ID, BB_PROJECT_ID: options.env.BB_PROJECT_ID },
      restOfEnvIsProcessEnv: Object.entries(processEnvAtCall[index]!).every(([key, value]) => ["PATH", "BB_THREAD_ID", "BB_PROJECT_ID"].includes(key) || options.env[key] === value),
    }));
    transcript[mode] = seen;
    expect(seen.map((call) => call.args.slice(0, 2).concat(call.args.slice(-1)))).toEqual([["workflows", "run", "--json"], ["workflows", "status", "--json"], ["workflows", "history", "--json"]]);
    const [run, poll, history] = seen as [typeof seen[number], typeof seen[number], typeof seen[number]];
    expect(run.args).toHaveLength(7);
    expect(run.args.slice(0, 3)).toEqual(["workflows", "run", "--script"]);
    expect([RESEARCH_SCRIPTS[mode as "survey"], RESEARCH_SCRIPTS[mode as "survey"].replace(', { title: "Combine" }]', "]")]).toContain(run.args[3]);
    expect(run.args[4]).toBe("--args");
    expect(JSON.parse(run.args[5]!)).toMatchObject({ question: params.question });
    expect(poll.args).toEqual(["workflows", "status", "wfr_1", "--json"]);
    expect(history.args).toEqual(["workflows", "history", "wfr_1", "--cursor", "0", "--limit", "1", "--json"]);
    for (const call of seen) {
      expect(call.file).toBe(process.env.BB_CLI ?? "bb");
      expect(call.timeout).toBe(30_000);
      expect(call.maxBuffer).toBe(16 * 1024 * 1024);
      expect(call.env).toEqual({ PATH: expect.stringContaining("/opt/homebrew/bin"), BB_THREAD_ID: threadId, BB_PROJECT_ID: "proj_1" });
      expect(call.restOfEnvIsProcessEnv).toBe(true);
    }
  });

  const failure = (message: string, stdout: unknown) => Object.assign(new Error(message), { stdout });
  test.each([
    ["a failing exit whose stdout carries the CLI's own JSON error uses that message", () => { throw failure("Command failed: bb workflows run", JSON.stringify({ ok: false, error: { message: "service says no" } })); }, "service says no"],
    ["a failing exit with non-JSON stdout keeps the process error's message", () => { throw failure("Command failed: bb workflows run", "not json"); }, "Command failed: bb workflows run"],
    ["a failing exit with no stdout keeps the process error's message", () => { throw failure("spawn bb ENOENT", undefined); }, "spawn bb ENOENT"],
    ["a thrown non-Error is stringified", () => { throw "plain failure"; }, "plain failure"],
    ["a successful exit that prints ok:false uses its error message", () => ({ stdout: JSON.stringify({ ok: false, error: { message: "launch refused" } }), stderr: "" }), "launch refused"],
    ["an ok:false document with no message is printed as its error JSON", () => ({ stdout: JSON.stringify({ ok: false, error: { code: "E_BUSY" } }), stderr: "" }), '{"code":"E_BUSY"}'],
    ["a run document without a runId is refused", () => ({ stdout: JSON.stringify({}), stderr: "" }), "bb workflows run returned no runId"],
  ])("launch error mapping: %s", async (name, behave, expected) => {
    const state = await setup();
    const threadId = await planner(state);
    execFileMock.mockImplementation(async (_file: string, args: string[]) => { if (args[1] !== "run") throw new Error(`unexpected ${args[1]}`); return behave(); });
    const reply = await research(state, threadId, { mode: "survey", question: "Who calls this?", items: ["a.ts"] });
    const message = /could not start the workflow \(([\s\S]*?)\), so start it yourself/.exec(reply)?.[1];
    transcript[`error: ${name}`] = message;
    expect(message).toBe(expected);
  });

  test("dump", () => { if (process.env.WF_CLI_TRANSCRIPT) writeFileSync(process.env.WF_CLI_TRANSCRIPT, JSON.stringify(transcript, null, 2)); });
});
