import { APPROVE, HEAD_SHA, REQUEST_CHANGES, chiefReview, delegate, execFileMock, ghHead, setup, start } from "./harness";

// A world for tests of the review gate: a Chief, workers with a branch, and answers for the git and gh calls the gate makes
// (`git ls-remote origin refs/heads/<branch>`, `git symbolic-ref`, `git status --porcelain`, `git merge-base --is-ancestor`, `gh pr view`).
// The test file must mock the child process itself (vi.mock is hoisted per file):
//   vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
// The gate is opened, the reviewer's verdict is sent, through the real chief_report and chief_review tools.

export const PROJECT_PATH = "/repo/gate-world";
export const BUILDER_PATH = "/repo/gate-world-builder";
export type GateWorld = Awaited<ReturnType<typeof gateWorld>>;
export type Verdict = "approve" | "request_changes";

export async function gateWorld(options: { /** cleanupApproved setting: true stamps cleanup_approved_at on completion, false turns cleanup off (default: the harness's). */ cleanup?: boolean; /** Runs before Chief starts (role models, settings). */ before?: (state: Awaited<ReturnType<typeof setup>>) => Promise<void> } = {}) {
  const git = {
    /** Pushed branch tips, by branch; a branch missing here is not on origin. */
    remote: new Map<string, string>(),
    /** What `git status --porcelain` prints in a builder's checkout. */
    dirty: "",
    /** Whether the builder's HEAD is in the pinned commit. */
    contained: true,
    /** `state` that `gh pr view --json state,headRefOid` answers; "fail" makes the call throw (forge unknown). */
    prState: "OPEN",
    /** The same answer per github pull request URL, ahead of prState. */
    prStates: new Map<string, string>(),
    /** Every git and gh call, oldest first. */
    calls: [] as string[][],
  };
  execFileMock.mockReset();
  execFileMock.mockImplementation((file: string, args: string[]) => Object.assign((async () => {
    const out = (stdout = "") => ({ stdout, stderr: "" });
    git.calls.push([file, ...args]);
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      if (args.includes("headRefName,headRefOid,baseRefName")) return out(ghHead("feature/from-forge"));
      const repo = args[args.indexOf("--repo") + 1];
      const prState = git.prStates.get(`https://github.com/${repo}/pull/${args[2]}`) ?? git.prState;
      if (prState === "fail") throw new Error("gh: no answer");
      return out(JSON.stringify({ state: prState, headRefOid: HEAD_SHA }));
    }
    if (file !== "git") throw new Error(`unexpected CLI ${file}`);
    if (args[0] === "ls-remote") {
      const branch = String(args[2]).replace("refs/heads/", "");
      const sha = git.remote.get(branch);
      return out(sha ? `${sha}\trefs/heads/${branch}\n` : "");
    }
    if (args[0] === "symbolic-ref") return out("origin/main\n");
    if (args[0] === "status") return out(git.dirty);
    if (args[0] === "merge-base" && !git.contained) throw new Error("not an ancestor");
    return out();
  })(), { child: { kill: () => undefined } }));

  const state = await setup({ projectPath: PROJECT_PATH, system: { usageLimits: async () => ({}), config: async () => ({ primaryHostId: "host_1" }) } });
  // The builder's checkout is a local path, so the gate checks its tree and its push as it does for a real worktree.
  state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
    id: environmentId, hostId: "host_1", path: BUILDER_PATH, workspaceProvisionType: environmentId.startsWith("env_worker") ? "managed-worktree" : null,
  }));
  if (options.cleanup !== undefined) await state.harness.behavior.setSettings({ cleanupApproved: options.cleanup });
  await options.before?.(state);
  const chief = (await start(state)).threadId;
  const chiefCtx = { threadId: chief, projectId: "proj_1" };
  const call = (name: string, params: object, ctx = chiefCtx) => state.harness.behavior.callAgentTool(name, params, ctx) as Promise<any>;
  const asThread = (threadId: string) => ({ threadId, projectId: "proj_1" });
  const setIdle = (threadId: string) => state.live.set(threadId, { ...state.live.get(threadId)!, status: "idle" });
  const refusal = async (promise: Promise<unknown>) => {
    try { await promise; } catch (error) { return (error as Error).message; }
    throw new Error("expected a refusal");
  };
  let branches = 0;

  const world = {
    state, chief, git, call, refusal, setIdle,
    row: (id: string) => state.db.prepare("SELECT * FROM managed_threads WHERE thread_id=?").get(id) as any,
    /** The newest gate row of this Chief. */
    gate: () => state.db.prepare("SELECT * FROM review_gates WHERE chief_thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(chief) as any,
    /** A worker on its own branch, pushed to origin. Not ready yet. */
    async worker(title = "Fix checkout totals", forge: { branch?: string; prUrl?: string } = {}) {
      const branch = forge.branch ?? `feature/gate-${++branches}`;
      git.remote.set(branch, HEAD_SHA);
      return { ...(await delegate(state, chief, title, { branch, ...(forge.prUrl ? { prUrl: forge.prUrl } : {}) })), branch };
    },
    /** A ready report from a worker (or fix run), then idle. */
    async ready(threadId: string, extra: object = {}) {
      await call("chief_report", { state: "ready", result: "Done.\n\n## Deviations from plan\nNone", ...extra }, asThread(threadId));
      setIdle(threadId);
    },
    /** chief_review: opens the gate (or restarts its missing sides). */
    open: (workerThreadId: string) => chiefReview(state, chief, { workerThreadId }),
    /** The reviewer's verdict through chief_report. */
    verdict: (reviewerId: string, verdict: Verdict, extra: object = {}) => call("chief_report", {
      state: "ready", result: verdict === "approve" ? "The change is right." : "Totals go negative.", ...(verdict === "approve" ? APPROVE : REQUEST_CHANGES), ...extra,
    }, asThread(reviewerId)),
    /** A blocked report. */
    block: (threadId: string, result = "The test setup is wrong.") => call("chief_report", { state: "blocked", result, blocker: result, recommendation: "Reroute it." }, asThread(threadId)),
    complete: (threadId: string, extra: object = {}) => call("chief_complete", { threadId, ...extra }),
    /** chief_delegate of a repair (a fix run, chat fix, docs repair); threadId is the row it created. */
    async delegateTo(params: object) {
      const text = await call("chief_delegate", { title: "Repair", mission: "Repair it.", ...params }) as string;
      const created = state.db.prepare("SELECT thread_id FROM managed_threads ORDER BY rowid DESC LIMIT 1").get() as { thread_id: string };
      return { text, threadId: created.thread_id };
    },
    /** A worker whose gate is open: ready, gate started, reviewer id. */
    async gated(title?: string, forge?: { branch?: string; prUrl?: string }) {
      const worker = await world.worker(title, forge);
      await world.ready(worker.threadId);
      const opened = await world.open(worker.threadId);
      return { worker, reviewer: opened.threadId, text: opened.text };
    },
    /** A gate that passed: approve. */
    async passed(title?: string, forge?: { branch?: string; prUrl?: string }) {
      const gated = await world.gated(title, forge);
      await world.verdict(gated.reviewer, "approve");
      return gated;
    },
  };
  return world;
}
