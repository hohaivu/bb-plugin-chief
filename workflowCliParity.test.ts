import { describe, expect, test, vi } from "vitest";
import { createWorkflowCli } from "./src/research/workflowCli";

// Contract: the `bb workflows` runner (retro's only workflow path) keeps its full argv, controlled env, timeout, buffer and error mapping.
const TABLE = "| Item | Finding | Evidence |";
const context = { threadId: "thr_9", projectId: "proj_1" };

function runner(execFileAsync: (file: string, args: string[], options: any) => Promise<{ stdout: string; stderr: string }>) {
  return createWorkflowCli({ serverPath: () => "/opt/homebrew/bin:/usr/bin", execFileAsync });
}

describe("createWorkflowCli runner", () => {
  test("launches `bb workflows <sub>` with the full argv, the calling thread's env, a 30 s timeout and a 16 MiB buffer", async () => {
    const execFileAsync = vi.fn(async () => ({ stdout: JSON.stringify({ runId: "wfr_1" }), stderr: "" }));
    expect(await runner(execFileAsync)("status", ["wfr_1"], context)).toEqual({ runId: "wfr_1" });
    const [file, args, options] = execFileAsync.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }];
    expect(file).toBe(process.env.BB_CLI ?? "bb");
    expect(args).toEqual(["workflows", "status", "wfr_1", "--json"]);
    expect(options.timeout).toBe(30_000);
    expect(options.maxBuffer).toBe(16 * 1024 * 1024);
    expect(options.env).toMatchObject({ PATH: "/opt/homebrew/bin:/usr/bin", BB_THREAD_ID: "thr_9", BB_PROJECT_ID: "proj_1" });
    expect(options.env.HOME).toBe(process.env.HOME);
  });

  test("history output is parsed as JSON Lines, one record per line", async () => {
    const stdout = [{ type: "run", result: { table: TABLE } }, { type: "page", nextCursor: null }].map((record) => JSON.stringify(record)).join("\n") + "\n";
    const parsed = await runner(async () => ({ stdout, stderr: "" }))("history", ["wfr_1", "--cursor", "0", "--limit", "1"], context);
    expect(parsed).toEqual([{ type: "run", result: { table: TABLE } }, { type: "page", nextCursor: null }]);
  });

  const failure = (message: string, stdout: unknown) => Object.assign(new Error(message), { stdout });
  test.each([
    ["a failing exit whose stdout carries the CLI's own JSON error uses that message", () => { throw failure("Command failed: bb workflows run", JSON.stringify({ ok: false, error: { message: "service says no" } })); }, "service says no"],
    ["a failing exit with non-JSON stdout keeps the process error's message", () => { throw failure("Command failed: bb workflows run", "not json"); }, "Command failed: bb workflows run"],
    ["a failing exit with no stdout keeps the process error's message", () => { throw failure("spawn bb ENOENT", undefined); }, "spawn bb ENOENT"],
    ["a thrown non-Error is stringified", () => { throw "plain failure"; }, "plain failure"],
    ["a successful exit that prints ok:false uses its error message", () => ({ stdout: JSON.stringify({ ok: false, error: { message: "launch refused" } }), stderr: "" }), "launch refused"],
    ["an ok:false document with no message is printed as its error JSON", () => ({ stdout: JSON.stringify({ ok: false, error: { code: "E_BUSY" } }), stderr: "" }), '{"code":"E_BUSY"}'],
  ])("error mapping: %s", async (_name, behave, expected) => {
    await expect(runner(async () => behave() as never)("run", [], context)).rejects.toThrow(new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  });
});
