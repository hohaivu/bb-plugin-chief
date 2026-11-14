import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { type State, readyIdle, report, rowOf, tool } from "./test/testerHelpers";
import { APPROVE, disposeAll, execFileMock, setup, start } from "./test/harness";
import { gitFixture } from "./test/gitFixture";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
// Real git (the branch step's proof is git ancestry), faked forge CLIs: only `execFile` is replaced.
vi.mock("node:child_process", async () => ({ ...(await vi.importActual<object>("node:child_process")), ...(await import("./test/execMock")).childProcessMock() }));
afterEach(disposeAll);

// Contracts (wave 1, src/runtime/cleanup.ts branch step): the job resolves its PR URLs (its own row's, plus its covered workers' for a reviewer),
// asks the forge only when origin holds nothing, and deletes the bb/ branch only for a merged PR whose head is the tip or contains it.
const PR = "https://github.com/acme/shop/pull/8";
const BRANCH = "bb/fix-totals-thr_abc123";
const KEPT = (count: number) => `branch kept: ${count} commit(s) not on origin and no merged task pull request contains them`;

type Forge = { state?: string; headRefOid?: string } | "fail";
type Setup = {
  /** What the task branch looks like: its tip, and the commit the PR's head is at. */
  layout: (fx: ReturnType<typeof gitFixture>) => { head: string };
  forge?: Forge | ((head: string) => Forge);
  role?: "worker" | "reviewer";
  prUrl?: string | null;
};

async function runBranchStep(options: Setup) {
  const fx = gitFixture();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const git = promisify(actual.execFile);
  fx.git("checkout", "-q", "-b", BRANCH, "main");
  const { head } = options.layout(fx);
  fx.git("checkout", "-q", "main");
  const tip = fx.sha(BRANCH);
  const forgeCalls: string[][] = [];
  const reply = typeof options.forge === "function" ? options.forge(head) : options.forge ?? { state: "MERGED", headRefOid: head };
  execFileMock.mockImplementation(async (file: string, args: string[], opts: object) => {
    if (file === "git") return git(file, args, opts);
    if (file === "gh" && args[0] === "pr" && args[1] === "view") {
      if (args.includes("headRefName,headRefOid,baseRefName")) return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: "a".repeat(40), baseRefName: "main" }), stderr: "" };
      forgeCalls.push([file, ...args]);
      if (reply === "fail") throw new Error("gh: not found");
      return { stdout: JSON.stringify(reply), stderr: "" };
    }
    throw new Error(`unexpected CLI ${file}`);
  });
  const state = await setup({ projectPath: fx.clone, system: { usageLimits: async () => ({}), config: async () => ({ primaryHostId: "host_1" }) } });
  await state.harness.behavior.setSettings({ cleanupApproved: true });
  const chief = (await start(state)).threadId;
  await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded fixture", prUrl: PR }, chief);
  const worker = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker'`).get() as { thread_id: string }).thread_id;
  await readyIdle(state, worker);
  let owner = worker;
  if (options.role === "reviewer") {
    await tool(state, "chief_review", { workerThreadId: worker }, chief);
    owner = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='reviewer'`).get() as { thread_id: string }).thread_id;
    await report(state, owner, { state: "ready", result: "Looks right", ...APPROVE });
    // The reviewer's own row has no PR: its PR can only come from the worker it covered.
    state.db.prepare(`UPDATE managed_threads SET pr_url=NULL WHERE thread_id=?`).run(owner);
    expect(rowOf(state, owner).pr_url).toBeNull();
  }
  if (options.prUrl !== undefined) state.db.prepare(`UPDATE managed_threads SET pr_url=? WHERE thread_id=?`).run(options.prUrl, worker);
  forgeCalls.length = 0;
  const archivedAt = Date.now() - 2 * 60 * 60_000;
  state.live.set(owner, { ...state.live.get(owner)!, archivedAt } as any); // later steps require the thread to still carry the job's archive time
  state.db.prepare(`INSERT INTO cleanup_jobs (thread_id, chief_thread_id, project_id, environment_id, branch, step, step_at, archived_at, created_at, updated_at)
    VALUES (?, ?, 'proj_1', NULL, ?, 'branch', ?, ?, ?, ?)`).run(owner, chief, BRANCH, archivedAt, archivedAt, 1_000, 1_000);
  return { state, fx, tip, head, owner, forgeCalls, cycle: () => state.supervisorCycle() };
}
const job = (state: State, id: string) => state.db.prepare(`SELECT step, outcome, attempts FROM cleanup_jobs WHERE thread_id=?`).get(id) as { step: string; outcome: string | null; attempts: number };
const keptAlerts = (state: State) => state.db.prepare(`SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key LIKE '%cleanup-branch-kept:alert'`).get() as { n: number };

/** Layouts on the task branch (checked out when they run): the PR head is the tip, or a descendant of it. */
const tipIsHead = (fx: ReturnType<typeof gitFixture>) => ({ head: (fx.commit("work"), fx.sha("HEAD")) });
const headAfterTip = (fx: ReturnType<typeof gitFixture>) => {
  const tip = (fx.commit("work"), fx.sha("HEAD"));
  fx.git("checkout", "-q", "-b", "pr-head", tip);
  fx.commit("start commit");
  const head = fx.sha("HEAD");
  fx.git("checkout", "-q", BRANCH);
  return { head };
};

describe("cleanup branch step with a task PR", () => {
  test("a merged PR whose head is the branch tip: the branch is deleted", async () => {
    const run = await runBranchStep({ layout: tipIsHead });
    try {
      await run.cycle();
      expect(job(run.state, run.owner)).toMatchObject({ step: "storage", outcome: "branch deleted" });
      expect(run.fx.hasBranch(BRANCH)).toBe(false);
      expect(run.forgeCalls).toEqual([["gh", "pr", "view", "8", "--json", "state,headRefOid", "--repo", "acme/shop"]]);
      expect(keptAlerts(run.state).n).toBe(0);
    } finally { run.fx.dispose(); }
  });

  test("a reviewer's branch resolves its PR through the worker it covered; the PR head is a descendant of the tip: deleted", async () => {
    const run = await runBranchStep({ layout: headAfterTip, role: "reviewer" });
    try {
      await run.cycle();
      expect(job(run.state, run.owner)).toMatchObject({ outcome: "branch deleted" });
      expect(run.fx.hasBranch(BRANCH)).toBe(false);
      expect(run.forgeCalls).toHaveLength(1);
    } finally { run.fx.dispose(); }
  });

  test.each<[string, Setup, number]>([
    ["the PR is open", { layout: tipIsHead, forge: (head) => ({ state: "OPEN", headRefOid: head }) }, 1],
    ["the PR is closed without a merge", { layout: tipIsHead, forge: (head) => ({ state: "CLOSED", headRefOid: head }) }, 1],
    ["the forge cannot say whether it is merged", { layout: tipIsHead, forge: "fail" }, 1],
    ["the merged PR reports no usable head", { layout: tipIsHead, forge: { state: "MERGED", headRefOid: "" } }, 1],
    ["the merged PR's head does not contain the tip (cherry-picked)", {
      layout: (fx) => {
        const tip = (fx.commit("work"), fx.sha("HEAD"));
        fx.git("checkout", "-q", "-b", "pr-head", "main");
        fx.commit("moved on");
        fx.git("cherry-pick", tip);
        const head = fx.sha("HEAD");
        fx.git("checkout", "-q", BRANCH);
        return { head };
      },
    }, 1],
    ["the branch has a commit after the merged PR's head", {
      layout: (fx) => { const head = (fx.commit("in the PR"), fx.sha("HEAD")); fx.commit("after the PR"); return { head }; },
    }, 2],
  ])("kept, tip untouched, alert sent: %s", async (_name, options, count) => {
    const run = await runBranchStep(options);
    try {
      await run.cycle();
      expect(job(run.state, run.owner)).toMatchObject({ step: "storage", outcome: KEPT(count) });
      expect(run.fx.sha(BRANCH)).toBe(run.tip);
      expect(run.forgeCalls).toHaveLength(1);
      expect(keptAlerts(run.state).n).toBe(1);
    } finally { run.fx.dispose(); }
  });

  test("a job whose threads carry no PR URL never calls the forge, and keeps the branch", async () => {
    const run = await runBranchStep({ layout: tipIsHead, prUrl: null });
    try {
      await run.cycle();
      expect(job(run.state, run.owner)).toMatchObject({ outcome: "branch kept: 1 commit(s) not on origin" });
      expect(run.fx.hasBranch(BRANCH)).toBe(true);
      expect(execFileMock.mock.calls.filter((call) => call[0] === "gh" || call[0] === "glab").filter((call) => !(call[1] as string[]).includes("headRefName,headRefOid,baseRefName"))).toEqual([]);
      expect(run.forgeCalls).toEqual([]);
    } finally { run.fx.dispose(); }
  });

  test("a branch origin already holds is deleted without any forge call", async () => {
    const run = await runBranchStep({
      layout: (fx) => { fx.commit("work"); fx.git("push", "-q", "origin", BRANCH); return { head: fx.sha("HEAD") }; },
    });
    try {
      await run.cycle();
      expect(job(run.state, run.owner)).toMatchObject({ outcome: "branch deleted" });
      expect(run.forgeCalls).toEqual([]);
    } finally { run.fx.dispose(); }
  });

  // Contract: a forge call that never answers throws inside the branch step (bounded by CLEANUP_CALL_MS = 30 s), so cleanupFail counts one attempt.
  // Nothing is deleted and no "kept" outcome is recorded: the job stays at the branch step for its next try.
  test("a forge call that never settles counts one failed attempt and leaves the branch and the job in place", async () => {
    const run = await runBranchStep({ layout: tipIsHead });
    const realSetTimeout = globalThis.setTimeout;
    const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
    try {
      let asked = 0;
      const gitCall = execFileMock.getMockImplementation()!;
      execFileMock.mockImplementation(async (file: string, args: string[], opts: object) => {
        if (file === "gh" && args.includes("state,headRefOid")) { asked += 1; return new Promise<never>(() => {}); }
        return gitCall(file, args, opts);
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
      const cycle = run.cycle();
      for (let waited = 0; asked === 0 && waited < 10_000; waited += 20) await realSleep(20); // real git runs, the forge call then hangs
      expect(asked).toBe(1);
      await vi.advanceTimersByTimeAsync(31_000);
      // Without the 30 s bound the cycle would wait for the hung forge call: it must settle on its own.
      expect(await Promise.race([cycle.then(() => "settled"), realSleep(3_000).then(() => "hung")])).toBe("settled");
      expect(job(run.state, run.owner)).toMatchObject({ step: "branch", outcome: null, attempts: 1 });
      expect(run.fx.sha(BRANCH)).toBe(run.tip);
      expect(keptAlerts(run.state).n).toBe(0);
    } finally {
      vi.useRealTimers();
      run.fx.dispose();
    }
  });
});
