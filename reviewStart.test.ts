import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, type ManagedRow } from "./server";
import { createReviewLedger } from "./reviewLedger";
import { createReviewStart, type PinnedHead } from "./reviewStart";
import { createThreadStore } from "./threadStore";

// Contract: the Review attempt module (reviewStart.ts) at its own interface. Its faults, its frozen identity and its
// whole-review budget are owned here; the broad reply/brief matrix stays in server.test.ts "review attempt oracle".
// Controlled local integration evidence: a fake host and forge, the real ThreadStore, ledger and SQLite migrations,
// and a temp git repository where a slice is computed. The reviewer row comes from the real launch arguments.

// The one seam for the cleanup after a finished impact slice (impactSlice.ts removes its temp attributes dir with rm).
const fsHook = vi.hoisted(() => ({ rm: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, default: actual, rm: (...args: Parameters<typeof actual.rm>) => (fsHook.rm ? fsHook.rm() : actual.rm(...args)) };
});

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  fsHook.rm = null;
  while (disposals.length) await disposals.pop()!();
});

const SHA_B = "b".repeat(40);
const SHA_A = "a".repeat(40);
const pr = (n: number) => `https://github.com/acme/shop/pull/${n}`;
const BUSY = new Set(["active", "starting", "stopping", "pending"]);
const NO_CHECKOUT = "no local checkout of the project on the plugin server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let worlds = 0;
type Options = { projectPath?: string | null; heads?: Record<string, PinnedHead | null> };

/** A standalone review attempt over real SQLite and the real ThreadStore; only the host, the forge and spawn are doubles. */
function world({ projectPath = null, heads = {} }: Options = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: `review-start-${++worlds}` });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createThreadStore<ManagedRow>(db, { onReload: () => undefined });
  const ledger = createReviewLedger<ManagedRow>(db, store.get, store, { busy: (status) => BUSY.has(status) });

  /** Writes the row exactly as managedSpawn.launch does (managedSpawn.ts:99-102), inside the same transaction as `inTransaction`. */
  let launched = 0;
  const launches: { id: string; args: any; row: any }[] = [];
  const managedSpawn = {
    prepare: vi.fn(async (_projectId: string, _pick: unknown) => ({ execution: {}, sectionId: "section" })),
    launch: vi.fn(async (_prepared: unknown, args: any, row: any, inTransaction?: (threadId: string) => void) => {
      const id = `R${++launched}`;
      launches.push({ id, args, row });
      db.transaction(() => {
        store.insert({ ...row, threadId: id, projectId: args.projectId, parentThreadId: row.chiefThreadId, title: args.title, state: "starting", status: "idle" });
        inTransaction?.(id);
      })();
      return { id, status: "idle" };
    }),
  };

  const forge = { head: vi.fn(async (pullRequest: string, _cwd: string | null): Promise<PinnedHead | null> => heads[pullRequest] ?? null) };
  const host = {
    settledLive: vi.fn(async (row: ManagedRow) => ({ status: "idle", deletedAt: null, archivedAt: null, environmentId: `env_${row.thread_id}` }) as any),
    projectPath: vi.fn(async (_projectId: string) => projectPath),
    projectHost: vi.fn(async (_projectId: string) => "host_proj"),
    environmentHost: vi.fn(async (_environmentId: string) => "host_env" as string | null),
    reusableEnvironment: vi.fn(async (_threadId: string): Promise<{ environmentId: string; hostId: string } | null> => null),
    checkoutSkip: vi.fn(async (_projectId: string): Promise<string | null> => null),
    recordedCommands: vi.fn(async (_threadId: string) => []),
    writeFile: vi.fn(async (_threadId: string, _relPath: string, _content: string): Promise<unknown> => undefined),
    alertChief: vi.fn(async (_row: ManagedRow, _key: string, _message: string): Promise<unknown> => undefined),
    logError: vi.fn((_message: string) => undefined),
  };

  /** What the plan owner answers: the review covers these workers (default: the worker alone). */
  let covers: string[] | null = null;
  const review = createReviewStart<ManagedRow>({
    db, store, ledger, managedSpawn: managedSpawn as any,
    plan: {
      reviewRefusal: () => null,
      reviewTargetsFor: (worker) => covers ? [worker, ...covers.filter((id) => id !== worker.thread_id).map((id) => store.get(id)!)] : [worker],
      planWavesFor: () => [],
    },
    controlsThread: (row, chiefId) => row.chief_thread_id === chiefId,
    host: host as any, forge, git: { env: () => process.env },
  });

  const chief = { thread_id: "chief", project_id: "proj" } as ManagedRow;
  const nextReport = (threadId: string) => store.reserveReport({
    threadId, state: "ready", result: "Done", summary: "Done", blocker: null, recommendation: null, verdict: null,
    planWaves: null, regression: 0, fails: null, findings: null, now: Date.now(),
  });
  /** A worker at `reports` reports (report_seq = reports), through the store's own reservation. */
  const worker = (id: string, over: { prUrl?: string; branch?: string; reports?: number } = {}) => {
    store.insert({ threadId: id, role: "worker", projectId: "proj", chiefThreadId: "chief", title: `Task ${id}`, state: "ready", status: "idle", prUrl: over.prUrl, branch: over.branch });
    for (let n = 0; n < (over.reports ?? 1); n++) nextReport(id);
  };
  const row = (id: string) => db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(id) as any;
  const targetRows = (reviewerId: string) =>
    db.prepare(`SELECT worker_thread_id, report_seq, head_sha, pr_url, branch FROM review_targets WHERE reviewer_thread_id=? ORDER BY worker_thread_id`).all(reviewerId) as any[];
  const contexts = () => host.writeFile.mock.calls.filter(([, relPath]) => relPath === "review-context.md").map(([, , content]) => content);
  return {
    db, store, ledger, review, chief, managedSpawn, launches, forge, host, worker, nextReport, row, targetRows, contexts,
    covering: (ids: string[]) => { covers = ids; },
  };
}

const headOf = (branch: string, sha = SHA_B): PinnedHead => ({ branch, sha, base: "main" });
const pinnedReply = (title: string, thread: string, sha: string) => `Started “Review · ${title}” in thread ${thread}. It reviews the pull request pinned to head commit ${sha} in its own worktree.`;

describe("identity: every target's report and head come from one capture", () => {
  test("a plan review records each target's own head, branch and report in the brief, the context, the targets and the reviewer row", async () => {
    const w = world({ heads: { [pr(1)]: headOf("feature/one-head"), [pr(2)]: null } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one-row", reports: 2 });
    w.worker("W2", { prUrl: pr(2), branch: "feature/two", reports: 5 });
    w.covering(["W1", "W2"]);

    const out = await w.review.startReview(w.chief, "W1");

    expect(out).toMatchObject({ threadId: "R1", created: true });
    expect(out.reply).toContain("One review covers the whole plan: W1, W2, each pull request pinned to its own head commit where the forge answered.");
    expect(w.launches[0]!.args.environment).toEqual({ type: "host", hostId: "host_proj", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/one-head" } } });
    const prompt: string = w.launches[0]!.args.prompt;
    expect(prompt).toContain(`- worker W1 “Task W1”: ${pr(1)} (branch feature/one-head, targeting main), pinned to ${SHA_B}: \`git fetch origin feature/one-head && git checkout --detach ${SHA_B}\`, then review \`git diff origin/main...${SHA_B}\``);
    expect(prompt).toContain(`- worker W2 “Task W2”: branch feature/two (${pr(2)}), head not readable, not pinned: \`git fetch origin feature/two\`, then review \`git diff <the project's default branch>...origin/feature/two\`; the verdict binds to its report 5`);
    // The context names the pinned head's branch for W1 (not the row's) and the row's branch for the unpinned W2.
    const [context] = w.contexts();
    expect(context).toContain("### feature/one-head (worker W1)");
    expect(context).toContain("### feature/two (worker W2)");
    expect(w.host.writeFile).toHaveBeenCalledWith("R1", "review-context.md", expect.any(String));
    expect(w.targetRows("R1")).toEqual([
      { worker_thread_id: "W1", report_seq: 2, head_sha: SHA_B, pr_url: pr(1), branch: "feature/one-row" },
      { worker_thread_id: "W2", report_seq: 5, head_sha: null, pr_url: pr(2), branch: "feature/two" },
    ]);
    // The reviewer row is the initiating worker's (W1: report 2, head b…), not the plan's newest.
    expect(w.row("R1")).toMatchObject({ role: "reviewer", worker_thread_id: "W1", reviewed_report_seq: 2, reviewed_head_sha: SHA_B });
  });

  test("a report that lands while the forge head is pending does not move the attempt's identity", async () => {
    const w = world();
    w.worker("W1", { prUrl: pr(1), branch: "feature/one", reports: 2 });
    const head = deferred<PinnedHead | null>();
    w.forge.head.mockImplementation(() => head.promise);

    const run = w.review.startReview(w.chief, "W1");
    await vi.waitFor(() => expect(w.forge.head).toHaveBeenCalledTimes(1));
    w.nextReport("W1"); // chief_report's own reservation: report 3
    expect(w.store.get("W1")!.report_seq).toBe(3);
    head.resolve(headOf("feature/one"));
    await run;

    expect(w.row("R1")).toMatchObject({ reviewed_report_seq: 2, reviewed_head_sha: SHA_B });
    expect(w.targetRows("R1")).toEqual([{ worker_thread_id: "W1", report_seq: 2, head_sha: SHA_B, pr_url: pr(1), branch: "feature/one" }]);
  });
});

describe("forge: a head the forge will not answer", () => {
  test("a null head reuses the worker's environment and binds the verdict to no commit", async () => {
    const w = world(); // forge.head answers null for every pull request, as the production adapter does when its CLI fails
    w.worker("W1", { prUrl: pr(1) });

    const out = await w.review.startReview(w.chief, "W1");

    expect(out.reply).toBe(`Started “Review · Task W1” in thread R1. The pull request head could not be read, so it reviews the worker's own environment and its verdict is not bound to a commit: chief_complete will need a fresh review once the forge answers, or an override. Impact slice skipped: W1: ${NO_CHECKOUT}.`);
    expect(w.launches[0]!.args.environment).toEqual({ type: "reuse", environmentId: "env_W1" });
    expect(w.managedSpawn.prepare).toHaveBeenCalledWith("proj", { role: "reviewer", hostId: "host_env" });
    expect(w.row("R1").reviewed_head_sha).toBeNull();
    expect(w.targetRows("R1")).toEqual([{ worker_thread_id: "W1", report_seq: 1, head_sha: null, pr_url: pr(1), branch: null }]);
  });
});

describe("impact slice: optional enrichment never refuses the review", () => {
  const pinned = () => world({ projectPath: "/checkout", heads: { [pr(1)]: headOf("feature/one") } });

  test.each([
    ["rejects", () => Promise.reject(new Error("host down"))],
    ["throws synchronously", () => { throw new Error("host down"); }],
  ])("a host check that %s skips the slice at once and the review launches", async (_name, fail) => {
    const w = pinned();
    w.worker("W1", { prUrl: pr(1) });
    w.host.checkoutSkip.mockImplementation(fail as any); // real timers, no advancing: it must settle by itself

    const out = await w.review.startReview(w.chief, "W1");

    expect(out.reply).toBe(`${pinnedReply("Task W1", "R1", SHA_B)} Impact slice skipped: W1: Error: host down.`);
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(1);
    expect(w.targetRows("R1")).toHaveLength(1);
    expect(w.contexts()).toHaveLength(1);
    expect(w.contexts()[0]).toContain("Skipped: Error: host down.");
  });

  test("a host check that never answers holds the launch until the 30 s deadline, then the review launches with a deadline skip", async () => {
    const w = pinned();
    w.worker("W1", { prUrl: pr(1) });
    w.host.checkoutSkip.mockImplementation(() => new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    let settled = false;
    const run = w.review.startReview(w.chief, "W1").finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.host.checkoutSkip).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_000);
    // The retained, bounded wait: nothing launched, nothing written, not settled.
    expect(settled).toBe(false);
    expect(w.managedSpawn.launch).not.toHaveBeenCalled();
    expect(w.contexts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await run;

    expect(out.reply).toBe(`${pinnedReply("Task W1", "R1", SHA_B)} Impact slice skipped: W1: deadline (30 s) passed.`);
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(1);
    expect(w.targetRows("R1")).toHaveLength(1);
    expect(w.contexts()).toHaveLength(1);
  });
});

describe("ancestry: a failed host check means the whole pull request", () => {
  test("a rejecting host check skips the range and the slice, and the review still launches", async () => {
    const w = world({ projectPath: "/checkout", heads: { [pr(1)]: headOf("feature/one") } });
    w.worker("W1", { prUrl: pr(1) });
    // The previous verdict recorded another head, so the ancestry check runs before the slices.
    w.db.prepare(`INSERT INTO reviewer_verdicts (reviewer_thread_id, worker_thread_id, verdict, report_seq, at, head_sha, worker_report_seq) VALUES ('Rold', 'W1', 'approve', 1, 1, ?, 1)`).run(SHA_A);
    w.host.checkoutSkip.mockImplementation(() => Promise.reject(new Error("host down")));

    const out = await w.review.startReview(w.chief, "W1");

    expect(out.reply).toBe(`${pinnedReply("Task W1", "R1", SHA_B)} Impact slice skipped: W1: Error: host down. Review scope: W1: whole pull request (Error: host down).`);
    expect(w.host.checkoutSkip).toHaveBeenCalledTimes(2); // ancestry first, then the slice
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(1);
    expect(w.targetRows("R1")).toEqual([{ worker_thread_id: "W1", report_seq: 1, head_sha: SHA_B, pr_url: pr(1), branch: null }]);
    expect(w.contexts()).toHaveLength(1);
  });
});

describe("review-context.md: a failed write never undoes the launch", () => {
  const withHead = () => {
    const w = world({ heads: { [pr(1)]: headOf("feature/one") } });
    w.worker("W1", { prUrl: pr(1) });
    return w;
  };
  const MESSAGE = (error: string) => `Could not write review-context.md for reviewer R1 after 3 attempts: ${error}. The reviewer will report blocked on the missing file; stop it (chief_stop) or nudge it with the context.`;
  const REPLY = `${pinnedReply("Task W1", "R1", SHA_B)} Impact slice skipped: W1: ${NO_CHECKOUT}.`;

  test("3 attempts on a 1 s and 2 s backoff, then one Chief alert with the exact key and message; the reply is unchanged", async () => {
    const w = withHead();
    w.host.writeFile.mockImplementation(() => Promise.reject(new Error("disk full")));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.host.writeFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(w.host.writeFile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.host.writeFile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(w.host.writeFile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const out = await run;

    expect(w.host.writeFile).toHaveBeenCalledTimes(3);
    expect(w.host.alertChief).toHaveBeenCalledTimes(1);
    const [alertRow, key, message] = w.host.alertChief.mock.calls[0]!;
    expect(alertRow.thread_id).toBe("R1");
    expect(key).toBe("review-context:R1");
    expect(message).toBe(MESSAGE("Error: disk full"));
    expect(w.host.logError).not.toHaveBeenCalled();
    expect(out.reply).toBe(REPLY);
    // The reviewer launched and is recorded before the write is tried.
    expect(w.targetRows("R1")).toHaveLength(1);
  });

  test("a write that throws synchronously is a failed attempt", async () => {
    const w = withHead();
    w.host.writeFile.mockImplementation(() => { throw new Error("sync disk"); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await run;

    expect(w.host.writeFile).toHaveBeenCalledTimes(3);
    expect(w.host.alertChief.mock.calls[0]![2]).toBe(MESSAGE("Error: sync disk"));
    expect(out.reply).toBe(REPLY);
  });

  test.each([
    ["rejects", () => Promise.reject(new Error("chief down"))],
    ["throws synchronously", () => { throw new Error("chief down"); }],
  ])("a Chief alert that %s is logged with the original message, never thrown", async (_name, fail) => {
    const w = withHead();
    w.host.writeFile.mockImplementation(() => Promise.reject(new Error("disk full")));
    w.host.alertChief.mockImplementation(fail as any);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await run;

    expect(w.host.alertChief).toHaveBeenCalledTimes(1);
    expect(w.host.logError).toHaveBeenCalledTimes(1);
    expect(w.host.logError).toHaveBeenCalledWith(`${MESSAGE("Error: disk full")} The Chief alert also failed: Error: chief down`);
    expect(out.reply).toBe(REPLY);
  });
});

/** A temp repo: `lib.ts` on main defines 20 helpers; the feature commit adds `use.ts` calling each, so a slice has 20 definition pointers. */
async function sliceRepo() {
  const dir = await mkdtemp(join(tmpdir(), "review-start-repo-"));
  disposals.push(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  const names = Array.from({ length: 20 }, (_, i) => `helperAlpha${String(i + 1).padStart(2, "0")}`);
  git("init", "-q", "-b", "main");
  await writeFile(join(dir, "lib.ts"), `${names.map((name) => `export function ${name}() {}`).join("\n")}\n`);
  git("add", "."); git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD"); // so origin/main resolves with no remote
  git("checkout", "-q", "-b", "feature");
  await writeFile(join(dir, "use.ts"), `${names.map((name) => `${name}();`).join("\n")}\n`);
  git("add", "."); git("commit", "-q", "-m", "feature");
  return { dir, sha: git("rev-parse", "HEAD") };
}

/** The pointer lines each target's `### …` block renders under `## Impact slice`, in order. */
function pointersPerTarget(context: string) {
  const section = context.slice(context.indexOf("## Impact slice")).split("\n\n## ")[0]!;
  // A single target has no `### …` heading: the whole section is its block.
  return section.split(/^### /m).slice(section.includes("\n### ") ? 1 : 0).map((block) => block.split("\n").filter((line) => /^- `[^`]+:\d+`/.test(line)).length);
}

describe("budget: one 30-entry allowance across the targets", () => {
  async function planOf(count: number) {
    const { dir, sha } = await sliceRepo();
    const heads = Object.fromEntries(Array.from({ length: count }, (_, i) => [pr(i + 1), headOf(`feature/t${i + 1}`, sha)]));
    const w = world({ projectPath: dir, heads });
    for (let i = 1; i <= count; i++) w.worker(`W${i}`, { prUrl: pr(i), branch: `feature/t${i}` });
    w.covering(Array.from({ length: count }, (_, i) => `W${i + 1}`));
    return w;
  }

  test("3 targets: each gets 10 and the context renders 30 pointers in all", async () => {
    const w = await planOf(3);
    await w.review.startReview(w.chief, "W1");
    const counts = pointersPerTarget(w.contexts()[0]);
    expect(counts).toEqual([10, 10, 10]);
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30);
  }, 60_000);

  test("7 targets: each asks 5, six use the 30 entries, the seventh gets none and states them omitted", async () => {
    const w = await planOf(7);
    await w.review.startReview(w.chief, "W1");
    const [context] = w.contexts();
    const counts = pointersPerTarget(context);
    expect(counts).toEqual([5, 5, 5, 5, 5, 5, 0]);
    expect(counts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30);
    const seventh = context.split(/^### /m).find((block: string) => block.startsWith("feature/t7 (worker W7)"))!;
    expect(seventh).toContain("No pointers outside the diff were found.");
    expect(seventh).toContain("20 more omitted");
  }, 60_000);

  test("a slice that finished stays final while a later cleanup hangs", async () => {
    // impactSlice runs no git step after onReady (only fs cleanup, plus a guideline lookup started before it), so the
    // plan's "late git step" variant has nothing to hang; a hanging cleanup is the closest late failure there is.
    const { dir, sha } = await sliceRepo();
    const w = world({ projectPath: dir, heads: { [pr(1)]: headOf("feature/t1", sha) } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/t1" });
    fsHook.rm = () => new Promise(() => undefined);

    const out = await w.review.startReview(w.chief, "W1"); // real timers: it must not wait for the cleanup or the 30 s deadline

    expect(out.reply).not.toContain("Impact slice skipped");
    expect(pointersPerTarget(w.contexts()[0])).toEqual([20]);
  }, 20_000);
});

describe("dedupe: one start per review key", () => {
  test("two concurrent starts launch once and share one answer; a third is told it is in flight", async () => {
    const w = world({ heads: { [pr(1)]: headOf("feature/one") } });
    w.worker("W1", { prUrl: pr(1) });

    const [first, second] = await Promise.all([w.review.startReview(w.chief, "W1"), w.review.startReview(w.chief, "W1")]);

    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    const third = await w.review.startReview(w.chief, "W1");
    expect(third).toEqual({ threadId: "R1", title: "Review · Task W1", created: false, reply: `Using existing “Review · Task W1” in thread R1. It reviews the pull request pinned to head commit ${SHA_B} in its own worktree.` });
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(1);
  });
});

describe("branch review: a branch or pull request no worker owns", () => {
  test("a pull request resolves to its head's branch; a second call reuses the review", async () => {
    const w = world({ projectPath: "/checkout", heads: { [pr(9)]: headOf("feature/from-head") } });

    const out = await w.review.startBranchReview(w.chief, { pullRequest: pr(9) });

    expect(w.forge.head).toHaveBeenCalledWith(pr(9), "/checkout");
    expect(out).toEqual({ threadId: "R1", title: "Review · feature/from-head", created: true, reply: "Started “Review · feature/from-head” in thread R1." });
    expect(w.launches[0]!.args.environment).toEqual({ type: "host", hostId: "host_proj", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/from-head" } } });
    expect(w.row("R1")).toMatchObject({ role: "reviewer", worker_thread_id: null, branch: "feature/from-head", pr_url: pr(9) });
    expect(await w.review.startBranchReview(w.chief, { pullRequest: pr(9) })).toMatchObject({ threadId: "R1", created: false, reply: "Using existing “Review · feature/from-head” in thread R1." });
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(1);
  });

  test("a pull request the forge will not answer is reviewed under its own reference as the branch", async () => {
    const w = world();
    const out = await w.review.startBranchReview(w.chief, { pullRequest: pr(9) });
    expect(out.title).toBe(`Review · ${pr(9)}`);
    expect(w.launches[0]!.args.environment.workspace.baseBranch).toEqual({ kind: "named", name: pr(9) });
    expect(w.row("R1")).toMatchObject({ branch: pr(9), pr_url: pr(9) });
  });

  test("a branch given directly is not looked up on the forge", async () => {
    const w = world();
    const out = await w.review.startBranchReview(w.chief, { branch: "feature/x" });
    expect(out.reply).toBe("Started “Review · feature/x” in thread R1.");
    expect(w.forge.head).not.toHaveBeenCalled();
    expect(w.row("R1").pr_url).toBeNull();
  });

  test("a branch a live worker carries is refused after the forge head is read and before any prepare or launch", async () => {
    const w = world({ heads: { [pr(9)]: headOf("feature/owned") } });
    w.worker("W1", { branch: "feature/owned" });

    await expect(w.review.startBranchReview(w.chief, { pullRequest: pr(9) })).rejects.toThrow("Branch feature/owned is owned by worker W1: use chief_review (workerThreadId: W1).");

    expect(w.forge.head).toHaveBeenCalledTimes(1);
    expect(w.managedSpawn.prepare).not.toHaveBeenCalled();
    expect(w.managedSpawn.launch).not.toHaveBeenCalled();
  });
});

// Contract (docs/specs/plan-chains.md "Review Worktree"): a pinned review reuses the worktree of the newest earlier pinned reviewer of
// the same task when the host says it is reusable, and in every other case launches a fresh managed worktree on the pull request branch.
describe("review worktree: reuse of the newest earlier pinned reviewer", () => {
  const fresh = (branch: string) => ({ type: "host", hostId: "host_proj", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: branch } } });
  const shared = { environmentId: "env_rev", hostId: "host_rev" };
  /** One pinned worker; each round is a new report and a finished previous reviewer, so the next chief_review starts a fresh reviewer. */
  function pinnedWorld(branch = "feature/one") {
    const w = world({ heads: { [pr(1)]: headOf(branch) } });
    w.worker("W1", { prUrl: pr(1), branch });
    const round = async () => {
      const out = await w.review.startReview(w.chief, "W1");
      w.nextReport(out.threadId); // the reviewer finishes: its report reserves, so the next review supersedes it
      w.nextReport("W1");
      return out;
    };
    return { w, round };
  }

  test("the first pinned review of a task launches a fresh managed worktree on the branch, and asks the host about no earlier reviewer", async () => {
    const { w, round } = pinnedWorld();
    await round();
    expect(w.launches[0]!.args.environment).toEqual(fresh("feature/one"));
    expect(w.host.reusableEnvironment).not.toHaveBeenCalled();
  });

  test("a later pinned review reuses the earlier reviewer's environment, on that host, and the brief tells the reviewer to check the commit out detached", async () => {
    const { w, round } = pinnedWorld();
    w.host.reusableEnvironment.mockResolvedValue(shared);
    await round();
    await round();
    expect(w.host.reusableEnvironment).toHaveBeenCalledExactlyOnceWith("R1");
    expect(w.managedSpawn.prepare).toHaveBeenLastCalledWith("proj", { role: "reviewer", hostId: "host_rev" });
    expect(w.launches[1]!.args.environment).toEqual({ type: "reuse", environmentId: "env_rev" });
    expect(w.launches[1]!.args.prompt).toContain(`\`git fetch origin feature/one && git checkout --detach ${SHA_B}\``);
  });

  test("repeated pinned rounds keep one worktree: only the first launch creates one, and each later round asks about the newest reviewer", async () => {
    const { w, round } = pinnedWorld();
    w.host.reusableEnvironment.mockResolvedValue(shared);
    for (let n = 0; n < 4; n++) await round();
    expect(w.launches.map((launch) => launch.args.environment.type)).toEqual(["host", "reuse", "reuse", "reuse"]);
    expect(w.launches.slice(1).map((launch) => launch.args.environment.environmentId)).toEqual(["env_rev", "env_rev", "env_rev"]);
    expect(w.host.reusableEnvironment.mock.calls.map(([id]) => id)).toEqual(["R1", "R2", "R3"]);
  });

  test.each([
    ["answers null", (w: ReturnType<typeof world>) => w.host.reusableEnvironment.mockResolvedValue(null)],
    ["rejects", (w: ReturnType<typeof world>) => w.host.reusableEnvironment.mockRejectedValue(new Error("host down"))],
    ["throws synchronously", (w: ReturnType<typeof world>) => w.host.reusableEnvironment.mockImplementation(() => { throw new Error("sync"); })],
  ])("when the host %s, the review still launches, on a fresh managed worktree", async (_name, arrange) => {
    const { w, round } = pinnedWorld();
    arrange(w);
    await round();
    const second = await round();
    expect(second).toMatchObject({ created: true });
    expect(w.host.reusableEnvironment).toHaveBeenCalledOnce();
    expect(w.launches[1]!.args.environment).toEqual(fresh("feature/one"));
    expect(w.managedSpawn.prepare).toHaveBeenLastCalledWith("proj", { role: "reviewer", hostId: "host_proj" });
  });

  test("an environment that is a target worker's own live environment is never reused", async () => {
    const { w, round } = pinnedWorld();
    w.host.reusableEnvironment.mockResolvedValue({ environmentId: "env_W1", hostId: "host_env" }); // settledLive gives W1 env_W1
    await round();
    await round();
    expect(w.launches[1]!.args.environment).toEqual(fresh("feature/one"));
  });

  test("an earlier unpinned review is never a reuse candidate: the host is not asked, and a later pinned review starts fresh", async () => {
    const w = world(); // the forge answers no head: the first review is unpinned and runs in the worker's own environment
    w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    const first = await w.review.startReview(w.chief, "W1");
    expect(w.launches[0]!.args.environment).toEqual({ type: "reuse", environmentId: "env_W1" });
    w.nextReport(first.threadId);
    w.nextReport("W1");
    w.forge.head.mockResolvedValue(headOf("feature/one"));
    w.host.reusableEnvironment.mockResolvedValue(shared);
    await w.review.startReview(w.chief, "W1");
    expect(w.host.reusableEnvironment).not.toHaveBeenCalled();
    expect(w.launches[1]!.args.environment).toEqual(fresh("feature/one"));
  });

  test("an unpinned later review keeps the worker's own environment even after a pinned reviewer exists", async () => {
    const { w, round } = pinnedWorld();
    w.host.reusableEnvironment.mockResolvedValue(shared);
    await round();
    w.forge.head.mockResolvedValue(null);
    await w.review.startReview(w.chief, "W1");
    expect(w.host.reusableEnvironment).not.toHaveBeenCalled();
    expect(w.launches[1]!.args.environment).toEqual({ type: "reuse", environmentId: "env_W1" });
  });
});
