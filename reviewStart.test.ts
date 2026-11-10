import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import type { ManagedRow } from "./src/types";
import { acceptOwnershipDeep } from "./test/docsOwnership";
import { createReviewLedger } from "./src/review/reviewLedger";
import { createReviewStart, type PinnedHead } from "./src/review/reviewStart";
import { createThreadStore } from "./src/db/threadStore";

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
type Options = { projectPath?: string | null; heads?: Record<string, PinnedHead | null>; engine?: () => unknown };

/** A standalone review attempt over real SQLite and the real ThreadStore; only the host, the forge and spawn are doubles. */
function world({ projectPath = null, heads = {}, engine }: Options = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: `review-start-${++worlds}` });
  disposals.push(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = createThreadStore<ManagedRow>(db, { onReload: () => undefined });
  const ledger = createReviewLedger<ManagedRow>(db, store.get, store, { busy: (status) => BUSY.has(status) });

  /** Writes the row exactly as managedSpawn.launch does (managedSpawn.ts:99-102), inside the same transaction as `inTransaction`. */
  let launched = 0;
  const launches: { id: string; args: any; row: any }[] = [];
  /** Every spawn and every file write, in the order they happened. */
  const events: string[] = [];
  const managedSpawn = {
    prepare: vi.fn(async (_projectId: string, _pick: unknown) => ({ execution: {}, sectionId: "section" })),
    launch: vi.fn(async (_prepared: unknown, args: any, row: any, inTransaction?: (threadId: string) => void) => {
      const id = `R${++launched}`;
      events.push("launch");
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
    writeFile: vi.fn(async (_threadId: string, relPath: string, _content: string): Promise<unknown> => { events.push(`storage:${relPath}`); }),
    /** Chief's data folder: <that host's data dir>/chief/<project>/<thread>/<name>. Answers the absolute path on the host it was asked to write on;
     * with no host it is the thread's own host, `host_worker`, which is never a reviewer host in these fixtures. */
    writeArtifact: vi.fn(async (threadId: string, projectId: string, name: string, _content: string, hostId?: string): Promise<string> => {
      events.push(`artifact:${name}`);
      return `/data/${hostId ?? "host_worker"}/chief/${projectId}/${threadId}/${name}`;
    }),
    alertChief: vi.fn(async (_row: ManagedRow, _key: string, _message: string): Promise<unknown> => undefined),
    logError: vi.fn((_message: string) => undefined),
  };

  /** What the plan owner answers: the review covers these workers (default: the worker alone). */
  let covers: string[] | null = null;
  const review = createReviewStart<ManagedRow>({
    db, store, ledger, managedSpawn: managedSpawn as any,
    plan: {
      reviewRefusal: () => null,
      retestDebts: () => ({ owed: [], waived: [] }),
      reviewTargetsFor: (worker) => covers ? [worker, ...covers.filter((id) => id !== worker.thread_id).map((id) => store.get(id)!)] : [worker],
      planWavesFor: () => [],
    },
    controlsThread: (row, chiefId) => row.chief_thread_id === chiefId,
    host: host as any, forge, git: { env: () => process.env },
    // Default: the shipped default setting. Written as a plain object so this file also runs unchanged against the base commit.
    engine: (engine ?? (async () => ({ mode: "reviewer", prAgentDir: "/unused" }))) as any,
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
    db, store, ledger, review, chief, managedSpawn, launches, events, forge, host, worker, nextReport, row, targetRows, contexts,
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

// ---------------------------------------------------------------------------------------------------------------------
// Review engine modes (docs/specs/review-engine.md). Reviewer mode must be byte-identical to base 9cf75e3.

/** Everything a caller or the reviewer can observe of one scenario: the reply, the launch arguments, the files, the alerts, the log. */
const observed = (w: ReturnType<typeof world>, out: unknown) => ({
  out,
  launches: w.launches.map((launch) => ({ id: launch.id, args: launch.args })),
  writes: w.host.writeFile.mock.calls.map(([threadId, relPath, content]) => ({ threadId, relPath, content })),
  alerts: w.host.alertChief.mock.calls.map(([row, key, message]) => ({ thread: (row as ManagedRow).thread_id, key, message })),
  logs: w.host.logError.mock.calls.map(([message]) => message),
});

/** The reviewer-mode fixtures. `engine` is the only thing that differs between the base capture and the head runs. */
async function scenarios(engine?: () => unknown) {
  const result: Record<string, ReturnType<typeof observed>> = {};
  {
    const w = world({ engine, heads: { [pr(1)]: headOf("feature/one") } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    result["single pinned"] = observed(w, await w.review.startReview(w.chief, "W1"));
  }
  {
    const w = world({ engine });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    result["single unpinned"] = observed(w, await w.review.startReview(w.chief, "W1"));
  }
  {
    const w = world({ engine, heads: { [pr(1)]: headOf("feature/one-head"), [pr(2)]: null } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one-row", reports: 2 });
    w.worker("W2", { prUrl: pr(2), branch: "feature/two", reports: 5 });
    w.covering(["W1", "W2"]);
    result["plan review, mixed pinning"] = observed(w, await w.review.startReview(w.chief, "W1"));
  }
  {
    const w = world({ engine, heads: { [pr(1)]: headOf("feature/one") } });
    w.worker("W1", { prUrl: pr(1) });
    w.host.writeFile.mockImplementation(() => Promise.reject(new Error("disk full")));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(3_000);
    result["review-context.md write fails"] = observed(w, await run);
    vi.useRealTimers();
  }
  {
    const w = world({ engine, projectPath: "/checkout", heads: { [pr(9)]: headOf("feature/from-head") } });
    result["branch review by pull request"] = observed(w, await w.review.startBranchReview(w.chief, { pullRequest: pr(9) }));
  }
  {
    const w = world({ engine });
    result["branch review by branch"] = observed(w, await w.review.startBranchReview(w.chief, { branch: "feature/x" }));
  }
  return result;
}

const ORACLE_FILE = join(import.meta.dirname, "test", "fixtures", "review-engine-9cf75e3.json");
const READ_FAILURE = "Could not read the review engine setting, using reviewer:";

describe("base oracle: reviewer mode is the behaviour of 9cf75e3", () => {
  // Run at the base commit (where no engine exists) with ORACLE_ONLY=capture ORACLE_OUT=<file>; the committed file is that run's output.
  test.runIf(process.env.ORACLE_OUT)("base oracle capture", async () => {
    await writeFile(process.env.ORACLE_OUT!, `${JSON.stringify(await scenarios(), null, 2)}\n`);
  });

  test.skipIf(process.env.ORACLE_OUT)("the default engine value is the base behaviour", async () => {
    const oracle = JSON.parse(await readFile(ORACLE_FILE, "utf8"));
    expect(acceptOwnershipDeep(await scenarios())).toEqual(oracle);
  });

  test.skipIf(process.env.ORACLE_OUT).each([
    ["a stored 'reviewer'", "reviewer"], ["an unknown name", "PR-AGENT"], ["an empty string", ""], ["a number", 3], ["nothing stored", undefined], ["null", null],
  ])("%s runs as the base did", async (_name, stored) => {
    const { reviewEngine } = await import("./src/review/prAgent");
    const oracle = JSON.parse(await readFile(ORACLE_FILE, "utf8"));
    expect(acceptOwnershipDeep(await scenarios(async () => reviewEngine({ reviewEngine: stored })))).toEqual(oracle);
  });

  test.skipIf(process.env.ORACLE_OUT)("a setting read that rejects runs as the base did, with one log line per worker review", async () => {
    const oracle = JSON.parse(await readFile(ORACLE_FILE, "utf8"));
    const got = acceptOwnershipDeep(await scenarios(() => Promise.reject(new Error("settings down"))));
    for (const [name, one] of Object.entries(got)) {
      const failures = one.logs.filter((message: string) => message.startsWith(READ_FAILURE));
      expect(failures, name).toHaveLength(name.startsWith("branch review") ? 0 : 1);
      for (const failure of failures) expect(failure).toContain("settings down");
      expect({ ...one, logs: one.logs.filter((message: string) => !message.startsWith(READ_FAILURE)) }, name).toEqual(oracle[name]);
    }
  });

  test.skipIf(process.env.ORACLE_OUT)("a setting read that throws synchronously runs as the base did", async () => {
    const oracle = JSON.parse(await readFile(ORACLE_FILE, "utf8"));
    const got = acceptOwnershipDeep(await scenarios(() => { throw new Error("settings sync"); }));
    expect(got["single pinned"]!.logs.filter((message: string) => message.startsWith(READ_FAILURE))).toHaveLength(1);
    expect(got["single pinned"]!.launches).toEqual(oracle["single pinned"].launches);
  });
});

describe.skipIf(process.env.ORACLE_OUT)("engine modes: the section and the wrapper reach the reviewer", () => {
  const DIR = "/opt/my pr-agent";
  const engineOf = (mode: "pr-agent" | "both") => async () => ({ mode, prAgentDir: DIR });
  const writesOf = (w: ReturnType<typeof world>) => w.host.writeFile.mock.calls.map(([, relPath]) => relPath);
  const fileOf = (w: ReturnType<typeof world>, name: string) => w.host.writeFile.mock.calls.find(([, relPath]) => relPath === name)?.[2] as string | undefined;
  /** Engine files go to Chief's data folder under `review-<report number>/<attempt id>/`; the names are given relative to that folder. */
  const ATTEMPT = /^review-\d+\/[0-9a-f]{8}\//;
  const artifactsOf = (w: ReturnType<typeof world>) => w.host.writeArtifact.mock.calls.map(([, , name]) => name.replace(ATTEMPT, ""));
  const artifactOf = (w: ReturnType<typeof world>, name: string) => w.host.writeArtifact.mock.calls.find(([, , written]) => written.endsWith(`/${name}`))?.[3] as string | undefined;
  /** The attempt folder a start wrote its files to (`review-<n>/<id>`), taken from the writes; every write of one start must share it. */
  const folderOfStart = (calls: Array<[string, string, string, string, string?]>) => {
    const folders = new Set(calls.map(([, , name]) => name.slice(0, name.lastIndexOf("/"))));
    expect([...folders]).toHaveLength(1);
    const [folder] = [...folders];
    expect(folder).toMatch(/^review-\d+\/[0-9a-f]{8}$/);
    return folder!;
  };
  /** The absolute folder the prompt must name for worker W1 on project `proj`, as the reviewer's host `host` (default `host_proj`) returned it. */
  const folderOf = (w: ReturnType<typeof world>, host = "host_proj") => `/data/${host}/chief/proj/W1/${folderOfStart(w.host.writeArtifact.mock.calls as any)}`;
  const executedLines = (prompt: string) => prompt.split("\n").filter((line) => line.startsWith("bash ") || line.startsWith("bb thread spawn"));

  /** The same fixture in reviewer mode: the prompt every other mode must extend. */
  async function plain(build: (w: ReturnType<typeof world>) => void, heads: Options["heads"]) {
    const w = world({ heads });
    build(w);
    await w.review.startReview(w.chief, "W1");
    return { prompt: w.launches[0]!.args.prompt as string, context: fileOf(w, "review-context.md") };
  }
  const pinnedOne = (w: ReturnType<typeof world>) => w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
  const heads1 = { [pr(1)]: headOf("feature/one") };

  test("pr-agent, one pinned target: the prompt is the reviewer prompt plus the section, the wrapper (with the configured directory) sits in Chief's folder at the literal path the prompt names", async () => {
    const base = await plain(pinnedOne, heads1);
    const w = world({ heads: heads1, engine: engineOf("pr-agent") });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    const prompt: string = w.launches[0]!.args.prompt;
    expect(prompt.startsWith(`${base.prompt}\n## Review engine: pr-agent\n`)).toBe(true);
    expect(prompt).toContain(`- worker W1 (branch feature/one): ${pr(1)} pinned to ${SHA_B} → pr-agent`);
    const FOLDER = folderOf(w);
    expect(prompt).toContain(`bash "${FOLDER}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`);
    expect(executedLines(prompt)).toEqual([`bash "${FOLDER}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`]);
    expect(prompt).not.toContain("$BB_THREAD_STORAGE/pr-agent-review.sh");
    expect(artifactsOf(w)).toEqual(["pr-agent-review.sh"]);
    expect(w.host.writeArtifact.mock.calls[0]!.slice(0, 2)).toEqual(["W1", "proj"]);
    expect(writesOf(w)).toEqual(["review-context.md"]);
    expect(fileOf(w, "review-context.md")).toBe(base.context);
    const script = artifactOf(w, "pr-agent-review.sh")!;
    expect(script.startsWith("#!")).toBe(true);
    expect(script).toContain(DIR);
    expect(w.host.writeFile.mock.calls.every(([threadId]) => threadId === "R1")).toBe(true);
    expect(w.host.alertChief).not.toHaveBeenCalled();
  });

  test("both: the helper prompt is the reviewer-mode prompt (never the engine prompt) plus the context", async () => {
    const base = await plain(pinnedOne, heads1);
    const w = world({ heads: heads1, engine: engineOf("both") });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    expect(artifactsOf(w)).toEqual(["pr-agent-review.sh", "review-helper.md"]);
    expect(writesOf(w)).toEqual(["review-context.md"]);
    const helper = artifactOf(w, "review-helper.md")!;
    expect(helper).toContain(`\n\n${base.prompt}\n\n## review-context.md\n${base.context}\n`.trimEnd());
    expect(helper).not.toContain("## Review engine");
    expect(helper).not.toContain("pr-agent-review.sh\" ");
    expect(w.launches[0]!.args.prompt).toContain("## Review engine: both");
    expect(w.launches[0]!.args.prompt).toContain("bb thread spawn");
  });

  test("both: the helper spawn and the wrapper run name the literal folder; no executed line uses $BB_THREAD_STORAGE", async () => {
    const w = world({ heads: heads1, engine: engineOf("both") });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    const prompt: string = w.launches[0]!.args.prompt;
    const FOLDER = folderOf(w);
    const commands = executedLines(prompt);
    expect(commands).toHaveLength(2);
    expect(commands.find((line) => line.startsWith("bb thread spawn"))).toContain(`--prompt-file "${FOLDER}/review-helper.md"`);
    expect(commands.find((line) => line.startsWith("bash "))).toBe(`bash "${FOLDER}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`);
    for (const command of commands) expect(command).not.toContain("$BB_THREAD_STORAGE");
  });

  test.each(["pr-agent", "both"] as const)("%s: the engine files are written before the reviewer is spawned, review-context.md after", async (mode) => {
    const w = world({ heads: heads1, engine: engineOf(mode) });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    const folder = folderOfStart(w.host.writeArtifact.mock.calls as any);
    expect(w.events).toEqual([
      `artifact:${folder}/pr-agent-review.sh`,
      ...(mode === "both" ? [`artifact:${folder}/review-helper.md`] : []),
      "launch",
      "storage:review-context.md",
    ]);
  });

  test("the folder is keyed by the reviewed report number", async () => {
    const w = world({ heads: heads1, engine: engineOf("pr-agent") });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one", reports: 3 });

    await w.review.startReview(w.chief, "W1");

    const folder = folderOfStart(w.host.writeArtifact.mock.calls as any);
    expect(folder).toMatch(/^review-3\//);
    expect(w.host.writeArtifact.mock.calls.map(([, , name]) => name)).toEqual([`${folder}/pr-agent-review.sh`]);
    expect(w.launches[0]!.args.prompt).toContain(`bash "/data/host_proj/chief/proj/W1/${folder}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`);
  });

  test("a plan review with two pinned targets lists both and names both pairs for the wrapper", async () => {
    const heads = { [pr(1)]: headOf("feature/one"), [pr(2)]: { branch: "feature/two", sha: SHA_A, base: "main" } };
    const w = world({ heads, engine: engineOf("pr-agent") });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    w.worker("W2", { prUrl: pr(2), branch: "feature/two" });
    w.covering(["W1", "W2"]);

    await w.review.startReview(w.chief, "W1");

    const prompt: string = w.launches[0]!.args.prompt;
    expect(prompt).toContain(`- worker W1 (branch feature/one): ${pr(1)} pinned to ${SHA_B} → pr-agent`);
    expect(prompt).toContain(`- worker W2 (branch feature/two): ${pr(2)} pinned to ${SHA_A} → pr-agent`);
    const FOLDER = folderOf(w);
    expect(executedLines(prompt)).toEqual([`bash "${FOLDER}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`, `bash "${FOLDER}/pr-agent-review.sh" ${pr(2)} ${SHA_A}`]);
    expect(artifactsOf(w)).toEqual(["pr-agent-review.sh"]);
  });

  test("mixed pinning: the unpinned target is listed as a direct review and the wrapper is still written for the pinned one", async () => {
    const heads = { [pr(1)]: headOf("feature/one"), [pr(2)]: null };
    const w = world({ heads, engine: engineOf("pr-agent") });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    w.worker("W2", { prUrl: pr(2), branch: "feature/two" });
    w.covering(["W1", "W2"]);

    await w.review.startReview(w.chief, "W1");

    const prompt: string = w.launches[0]!.args.prompt;
    expect(prompt).toContain("- worker W2 (branch feature/two): not pinned → direct review (no pinned pull request head)");
    expect(prompt).toContain(`- worker W1 (branch feature/one): ${pr(1)} pinned to ${SHA_B} → pr-agent`);
    expect(artifactsOf(w)).toEqual(["pr-agent-review.sh"]);
  });

  test.each(["pr-agent", "both"] as const)("%s with a single target that has no head: the direct line, no wrapper, no helper file", async (mode) => {
    const w = world({ engine: engineOf(mode) });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    const prompt: string = w.launches[0]!.args.prompt;
    expect(prompt).toContain(`## Review engine: ${mode}`);
    expect(prompt).toContain("no pinned pull request head");
    expect(prompt).not.toContain("pr-agent-review.sh");
    expect(prompt).not.toContain("bb thread spawn");
    expect(writesOf(w)).toEqual(["review-context.md"]);
    expect(w.host.writeArtifact).not.toHaveBeenCalled();
  });

  test("an engine read that rejects is the reviewer-mode prompt and files, and one log line", async () => {
    const base = await plain(pinnedOne, heads1);
    const w = world({ heads: heads1, engine: () => Promise.reject(new Error("store down")) });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    expect(w.launches[0]!.args.prompt).toBe(base.prompt);
    expect(writesOf(w)).toEqual(["review-context.md"]);
    expect(w.host.writeArtifact).not.toHaveBeenCalled();
    expect(w.host.logError).toHaveBeenCalledTimes(1);
  });

  test.each(["pr-agent", "both"] as const)("a branch review in %s mode has no engine section and writes no engine file", async (mode) => {
    const w = world({ engine: engineOf(mode), heads: { [pr(9)]: headOf("feature/from-head") }, projectPath: "/checkout" });
    const base = world({ heads: { [pr(9)]: headOf("feature/from-head") }, projectPath: "/checkout" });

    await w.review.startBranchReview(w.chief, { pullRequest: pr(9) });
    await base.review.startBranchReview(base.chief, { pullRequest: pr(9) });

    expect(w.launches[0]!.args.prompt).toBe(base.launches[0]!.args.prompt);
    expect(w.launches[0]!.args.prompt).not.toContain("## Review engine");
    expect(writesOf(w)).toEqual(writesOf(base));
    expect(w.host.writeArtifact).not.toHaveBeenCalled();
  });

  describe("a failed engine file never undoes the launch", () => {
    const FALLBACK = "The reviewer falls back to a direct review.";
    /** Fails every write of `names` (to Chief's folder or the reviewer's storage); the others succeed. */
    async function failing(mode: "pr-agent" | "both", names: string[], mixed = false) {
      const w = world({ heads: mixed ? { [pr(1)]: headOf("feature/one"), [pr(2)]: null } : heads1, engine: engineOf(mode) });
      pinnedOne(w);
      if (mixed) {
        w.worker("W2", { prUrl: pr(2), branch: "feature/two" });
        w.covering(["W1", "W2"]);
      }
      const fails = (name: string) => names.some((failed) => name.endsWith(failed));
      w.host.writeFile.mockImplementation(async (_threadId, relPath) => { if (fails(relPath)) throw new Error("disk full"); });
      w.host.writeArtifact.mockImplementation(async (threadId, projectId, name, _content, hostId) => {
        if (fails(name)) throw new Error("disk full");
        return `/data/${hostId}/chief/${projectId}/${threadId}/${name}`;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = w.review.startReview(w.chief, "W1");
      await vi.advanceTimersByTimeAsync(12_000);
      const out = await run;
      return { w, out };
    }
    const attempts = (w: ReturnType<typeof world>, name: string) => w.host.writeArtifact.mock.calls.filter(([, , written]) => written.endsWith(name)).length;

    test("the wrapper write fails 3 times: the reviewer is still launched with the plain prompt, one alert names the file, the review-context.md write is untouched", async () => {
      const base = await plain(pinnedOne, heads1);
      const { w, out } = await failing("pr-agent", ["pr-agent-review.sh"]);

      expect(out).toMatchObject({ threadId: "R1", created: true });
      expect(attempts(w, "pr-agent-review.sh")).toBe(3);
      expect(w.host.writeFile.mock.calls.filter(([, relPath]) => relPath === "review-context.md")).toHaveLength(1);
      expect(w.launches[0]!.args.prompt).toBe(base.prompt);
      expect(w.host.alertChief).toHaveBeenCalledTimes(1);
      const [alertRow, key, message] = w.host.alertChief.mock.calls[0]!;
      expect(alertRow.chief_thread_id).toBe("chief");
      expect(key).toMatch(/pr-agent-review:W1$/);
      expect(message).toContain("pr-agent-review.sh");
      expect(message).toContain("after 3 attempts: Error: disk full");
      expect(message).toContain(FALLBACK);
      expect(w.targetRows("R1")).toHaveLength(1);
    });

    test("both: a helper-file failure alerts under its own key, the wrapper stays written and the launch stays", async () => {
      const { w, out } = await failing("both", ["review-helper.md"]);

      expect(out).toMatchObject({ threadId: "R1" });
      expect(w.host.alertChief.mock.calls.map(([, key]) => key)).toEqual([expect.stringMatching(/review-helper:W1$/)]);
      expect(w.host.alertChief.mock.calls[0]![2]).toContain("review-helper.md");
      expect(w.host.alertChief.mock.calls[0]![2]).toContain(FALLBACK);
      expect(attempts(w, "pr-agent-review.sh")).toBe(1);
      expect(attempts(w, "review-helper.md")).toBe(3);
    });

    // Contract (docs/specs/review-engine.md, Flow 5): a helper prompt that cannot be written leaves no helper lines and no helper spawn command; the
    // reviewer does the direct half itself: a direct review of EVERY target (definitive pr-agent outcomes and the unpinned target included) combined with
    // the pr-agent outcomes. Regression: dropping the both-mode obligation with the helper lets a definitive pr-agent result stand in for the review.
    // The plan is mixed (one pinned, one unpinned target) so a direct half limited to the wrapper's targets fails too.
    test("both: a helper-file failure drops the helper lines and the spawn command, keeps the wrapper run, and tells the reviewer to review every target directly and combine", async () => {
      const { w } = await failing("both", ["review-helper.md"], true);

      const prompt: string = w.launches[0]!.args.prompt;
      expect(prompt).toContain("## Review engine: both");
      expect(executedLines(prompt)).toEqual([`bash "${folderOf(w)}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`]);
      // No helper lifecycle: nothing to spawn, wait for, stop, read or archive, and no stop-confirmation rule.
      for (const gone of ["bb thread spawn", "review-helper.md", "Helper (start it first)", "<helper id>", "bb thread wait", "bb thread show", "bb thread stop", "bb thread output", "bb thread archive", "helper prompt missing", "helper failed", "helper timeout", "shared checkout"]) {
        expect(prompt).not.toContain(gone);
      }
      // The direct half is the reviewer's, over every target, definitive outcomes included.
      expect(prompt).toContain("Direct half: the helper prompt was not written, so you do it.");
      expect(prompt).toContain("review every target yourself as described above, including targets with a definitive `changes_required` or `no_concerns_found` outcome");
      expect(prompt).toContain("does not re-verify or reclassify pr-agent's definitive findings");
      expect(prompt).toContain("Combine: your own direct findings for every target plus the pr-agent half under the outcomes above. Set `regression: true` when your direct review found a regression.");
      // Both-mode outcome rules, not the pr-agent-only ones.
      expect(prompt).toContain("Its findings stay nits; the direct half covers the target.");
      expect(prompt).not.toContain("confirm, drop or reclassify each");
      expect(prompt).toContain("The target has only the direct half.");
      expect(prompt).toContain("- not pinned: the direct half only.");
      expect(prompt).toContain("- worker W2 (branch feature/two): not pinned → direct review (no pinned pull request head)");
      expect(prompt).toContain("Aggregate once:");
      expect(prompt).toContain("Send one chief_report.");
      expect(prompt).toContain("Result: the first line is `Engine: both`");
      expect(prompt).toContain("Add `direct half: reviewer (helper prompt not written)`.");
      expect(prompt).not.toContain("`direct half: helper`");
    });

    // Control: with the helper written, the same plan keeps the helper lifecycle and the helper-based direct half.
    test("both: a written helper prompt keeps the helper lines, the spawn command and the helper-based direct half", async () => {
      const { w } = await failing("both", [], true);

      const prompt: string = w.launches[0]!.args.prompt;
      expect(executedLines(prompt)).toEqual([
        expect.stringContaining(`--prompt-file "${folderOf(w)}/review-helper.md"`),
        `bash "${folderOf(w)}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`,
      ]);
      expect(prompt).toContain("Helper (start it first)");
      expect(prompt).toContain("bb thread wait <helper id> --status idle --timeout 540s");
      expect(prompt).toContain("Combine: the direct half is the helper's findings");
      expect(prompt).toContain("Add `direct half: helper` or `direct half: reviewer (<reason>)`.");
      expect(prompt).toContain("run `bb thread archive <helper id>`");
      expect(prompt).toContain("Its findings stay nits; the direct half covers the target.");
      expect(prompt).not.toContain("the helper prompt was not written");
      expect(prompt).not.toContain("direct half: reviewer (helper prompt not written)");
    });

    test("the context and the wrapper both fail: two alerts, each under its own key, the context's keeps its own consequence", async () => {
      const { w, out } = await failing("pr-agent", ["review-context.md", "pr-agent-review.sh"]);

      expect(out).toMatchObject({ threadId: "R1" });
      expect(w.host.alertChief.mock.calls.map(([, key]) => key)).toEqual([expect.stringMatching(/pr-agent-review:W1$/), "review-context:R1"]);
      expect(w.host.alertChief.mock.calls[1]![2]).toBe("Could not write review-context.md for reviewer R1 after 3 attempts: Error: disk full. The reviewer will report blocked on the missing file; stop it (chief_stop) or nudge it with the context.");
    });
  });

  // Contract (docs/specs/review-engine.md, Engine folder): the folder holds a fresh attempt id for each review start, so a repeat review of the
  // same worker and report never reads another attempt's files. Regression: one folder per worker and report lets attempt 2 run attempt 1's prompt.
  describe("per-attempt engine folder", () => {
    /** One pinned worker; attempt 1 finishes (its reviewer reports) and the pull request moves to a new head, so a second review starts on the same report. */
    async function twoAttempts(mode: "pr-agent" | "both", second?: (w: ReturnType<typeof world>) => void) {
      const w = world({ heads: heads1, engine: engineOf(mode) });
      pinnedOne(w);
      const first = await w.review.startReview(w.chief, "W1");
      const firstWrites = [...w.host.writeArtifact.mock.calls] as any[];
      w.nextReport(first.threadId);
      w.forge.head.mockResolvedValue(headOf("feature/one", SHA_A));
      second?.(w);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const run = w.review.startReview(w.chief, "W1");
      await vi.advanceTimersByTimeAsync(12_000);
      const out = await run;
      vi.useRealTimers();
      const secondWrites = w.host.writeArtifact.mock.calls.slice(firstWrites.length) as any[];
      return { w, out, firstWrites, secondWrites };
    }

    test.each(["pr-agent", "both"] as const)("%s: two reviews of the same worker and report write to different folders, and the second prompt names only its own files", async (mode) => {
      const { w, out, firstWrites, secondWrites } = await twoAttempts(mode);

      expect(out).toMatchObject({ threadId: "R2", created: true });
      const [first, second] = [folderOfStart(firstWrites), folderOfStart(secondWrites)];
      expect(first).toMatch(/^review-1\//);
      expect(second).toMatch(/^review-1\//);
      expect(second).not.toBe(first);
      const prompt: string = w.launches[1]!.args.prompt;
      expect(prompt).not.toContain(first);
      expect(prompt).toContain(`bash "/data/host_proj/chief/proj/W1/${second}/pr-agent-review.sh" ${pr(1)} ${SHA_A}`);
      if (mode === "both") expect(prompt).toContain(`--prompt-file "/data/host_proj/chief/proj/W1/${second}/review-helper.md"`);
      // Attempt 1's prompt still names attempt 1's folder: the later start did not rewrite it.
      expect(w.launches[0]!.args.prompt).toContain(`/data/host_proj/chief/proj/W1/${first}/pr-agent-review.sh`);
    });

    test("both: attempt 1 wrote its helper prompt, attempt 2's helper writes all fail: attempt 2 never spawns attempt 1's helper prompt and falls back to the direct half", async () => {
      const { w, firstWrites, secondWrites } = await twoAttempts("both", (world2) => {
        const succeed = world2.host.writeArtifact.getMockImplementation()!;
        world2.host.writeArtifact.mockImplementation(async (threadId, projectId, name, content, hostId) => {
          if (name.endsWith("review-helper.md")) throw new Error("disk full");
          return succeed(threadId, projectId, name, content, hostId);
        });
      });

      const first = folderOfStart(firstWrites);
      expect(firstWrites.map(([, , name]) => name.replace(ATTEMPT, ""))).toEqual(["pr-agent-review.sh", "review-helper.md"]);
      expect(secondWrites.filter(([, , name]) => name.endsWith("review-helper.md"))).toHaveLength(3);
      const prompt: string = w.launches[1]!.args.prompt;
      expect(prompt).not.toContain("bb thread spawn");
      expect(prompt).not.toContain("review-helper.md");
      expect(prompt).not.toContain(first);
      expect(prompt).toContain("direct half: reviewer (helper prompt not written)");
      expect(w.host.alertChief.mock.calls.map(([, key]) => key)).toEqual([expect.stringMatching(/\/review-helper:W1$/)]);
    });
  });

  // Contract (docs/specs/review-engine.md, Engine folder): the engine files are written on the host the reviewer runs on, and the section names the
  // paths that host returned. Regression: writing on the worker's host renders paths the reviewer's host does not have.
  describe("engine files on the reviewer's host", () => {
    const hostsOf = (w: ReturnType<typeof world>) => w.host.writeArtifact.mock.calls.map(([, , , , hostId]) => hostId);

    test("a pinned review writes every engine file on the project's reviewer host, not the worker's host, and the prompt names that host's paths", async () => {
      const w = world({ heads: heads1, engine: engineOf("both") });
      w.host.projectHost.mockResolvedValue("host_reviewer");
      pinnedOne(w);

      await w.review.startReview(w.chief, "W1");

      expect(hostsOf(w)).toEqual(["host_reviewer", "host_reviewer"]);
      const prompt: string = w.launches[0]!.args.prompt;
      const folder = folderOf(w, "host_reviewer");
      expect(executedLines(prompt)).toEqual([
        expect.stringContaining(`--prompt-file "${folder}/review-helper.md"`),
        `bash "${folder}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`,
      ]);
      expect(prompt).not.toContain("/data/host_worker/");
      expect(prompt).not.toContain("/data/host_proj/");
      expect(w.managedSpawn.prepare).toHaveBeenCalledWith("proj", { role: "reviewer", hostId: "host_reviewer" });
    });

    test("a review that reuses an earlier reviewer's worktree writes the engine files on that worktree's host", async () => {
      const w = world({ heads: heads1, engine: engineOf("pr-agent") });
      pinnedOne(w);
      const first = await w.review.startReview(w.chief, "W1");
      w.nextReport(first.threadId);
      w.nextReport("W1");
      w.host.reusableEnvironment.mockResolvedValue({ environmentId: "env_rev", hostId: "host_rev" });

      await w.review.startReview(w.chief, "W1");

      expect(hostsOf(w)).toEqual(["host_proj", "host_rev"]);
      expect(w.launches[1]!.args.prompt).toContain(`bash "/data/host_rev/chief/proj/W1/review-2/`);
      expect(w.launches[1]!.args.prompt).not.toContain("/data/host_proj/");
    });
  });
});
