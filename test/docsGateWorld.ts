import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { delegate, execFileMock, setup, start } from "./harness";
import { readyIdle, tool } from "./testerHelpers";

// The docs/ ownership gate world: a bare origin with main, the project's clone `work`, and a `peer` clone that pushes the task branch the way a worker does.
// Git runs for real (recorded); gh answers from a stub. Shared by docsGate.test.ts and docsOwnershipCrossPlan.test.ts.
const PRIMARY = { config: async () => ({ primaryHostId: "host_1" }), usageLimits: async () => ({}) };
export const NO_TESTER = { testsSkipped: "tests are not under test here" };
export const PR = "https://github.com/o/r/pull/7";
let realExecPromise: Promise<(file: string, args: string[], options: object) => Promise<{ stdout: string; stderr: string }>> | undefined;
const realExec = async () => realExecPromise ??= (async () => {
  const childProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return (await import("node:util")).promisify(childProcess.execFile) as any;
})();
export const git = async (cwd: string, ...args: string[]) =>
  (await (await realExec())("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();

/** A bare origin with main, the project's clone `work`, and a `peer` clone that pushes the task branch the way a worker does. */
export async function world(opts: { path?: boolean; primaryHostId?: string; ghHead?: (call: string[]) => string | Error } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chief-docs-gate-")));
  const origin = join(root, "origin.git");
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  const peer = join(root, "peer");
  await git(root, "clone", "-q", origin, peer);
  await git(peer, "checkout", "-q", "-b", "main");
  let n = 0;
  const commit = async (file: string, subject: string, trailer?: string) => {
    await mkdir(dirname(join(peer, file)), { recursive: true });
    await writeFile(join(peer, file), `${subject} ${n += 1}\n`);
    await git(peer, "add", "-A");
    await git(peer, "commit", "-q", "-m", subject, ...(trailer ? ["--trailer", `Chief-Spec-Writer: ${trailer}`] : []));
    await git(peer, "push", "-q", "origin", "HEAD:task");
    return git(peer, "rev-parse", "HEAD");
  };
  await writeFile(join(peer, "a.txt"), "base\n");
  await git(peer, "add", "-A");
  await git(peer, "commit", "-q", "-m", "base");
  await git(peer, "push", "-q", "origin", "main");
  const work = join(root, "work");
  await git(root, "clone", "-q", "-b", "main", origin, work);
  await git(peer, "checkout", "-q", "-b", "task");
  await commit("src/code.ts", "code");

  const state = await setup({ projectPath: opts.path === false ? undefined : work, system: { ...PRIMARY, config: async () => ({ primaryHostId: opts.primaryHostId ?? "host_1" }) } });
  const real = await realExec();
  const gitCalls: string[][] = [];
  execFileMock.mockImplementation((file: string, args: string[], options: any) => {
    if (file === "git") { gitCalls.push(args); return real(file, args, options); }
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      const answer = (opts.ghHead ?? (() => new Error("gh: not found")))(args);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ stdout: answer, stderr: "" });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  });
  const chief = await start(state);
  const call = (name: string, params: object) => tool(state, name, params, chief.threadId) as Promise<string>;
  const worker = async (title: string, forge: { replaces?: string; kind?: string; prUrl?: string; branch?: string } = {}) => {
    const row = await delegate(state, chief.threadId, title, { branch: "task", ...forge });
    await readyIdle(state, row.threadId, "Done");
    return row.threadId;
  };
  const rowState = (id: string) => (state.db.prepare("SELECT state FROM managed_threads WHERE thread_id=?").get(id) as { state: string }).state;
  /** The docs/ checks this world ran against origin: a docs-history read of the task branch. */
  const docsReads = () => gitCalls.filter((args) => args.includes("--no-merges"));
  return { state, chief, workDir: work, commit, call, worker, rowState, docsReads, gitCalls, headSha: () => git(peer, "rev-parse", "HEAD") };
}
export type World = Awaited<ReturnType<typeof world>>;
