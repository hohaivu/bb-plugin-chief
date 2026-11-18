import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import type { ManagedRow } from "./src/types";
import { REVIEWER_NATIVE_LINE } from "./test/harness";
import { NATIVE_NO_RESHAPE_LINE } from "./test/reviewWave1";
import { createReviewLedger } from "./src/review/reviewLedger";
import { createReviewStart, type PinnedHead } from "./src/review/reviewStart";
import type { PlanWave } from "./src/plan/waveSchedule";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let worlds = 0;
type Options = { projectPath?: string | null; heads?: Record<string, PinnedHead | null>; engine?: () => unknown; waves?: PlanWave[]; gitEnv?: NodeJS.ProcessEnv; planBaseOf?: (row: ManagedRow) => { base: string } | { skipped: string } | null };

/** A standalone review attempt over real SQLite and the real ThreadStore; only the host, the forge and spawn are doubles. */
function world({ projectPath = null, heads = {}, engine, waves = [], gitEnv, planBaseOf }: Options = {}) {
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
    localPath: vi.fn(async (_environmentId: string): Promise<string | null> => null),
    heavyPath: vi.fn(async (_hostId: string): Promise<string | null> => null),
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
      reviewTargetsFor: (worker) => covers ? [worker, ...covers.filter((id) => id !== worker.thread_id).map((id) => store.get(id)!)] : [worker],
      planWavesFor: () => waves,
      ...(planBaseOf ? { planBaseOf } : {}),
    },
    controlsThread: (row, chiefId) => row.chief_thread_id === chiefId,
    host: host as any, forge, git: { env: () => gitEnv ?? process.env },
    // Default: the shipped default setting. Written as a plain object so this file also runs unchanged against the base commit.
    engine: (engine ?? (async () => ({ mode: "reviewer", prAgentDir: "/unused" }))) as any,
  });

  const chief = { thread_id: "chief", project_id: "proj" } as ManagedRow;
  const nextReport = (threadId: string) => store.reserveReport({
    threadId, state: "ready", result: "Done", summary: "Done", blocker: null, recommendation: null, verdict: null,
    planWaves: null, regression: 0, fails: null, findings: null, now: Date.now(),
  });
  /** A worker at `reports` reports (report_seq = reports), through the store's own reservation. */
  const worker = (id: string, over: { prUrl?: string; branch?: string; reports?: number; kind?: string; planWave?: number } = {}) => {
    store.insert({ threadId: id, role: "worker", projectId: "proj", chiefThreadId: "chief", title: `Task ${id}`, state: "ready", status: "idle", prUrl: over.prUrl, branch: over.branch ?? `feature/${id.toLowerCase()}`, kind: over.kind, ...(over.planWave ? { planThreadId: "P", planWave: over.planWave } : {}) });
    for (let n = 0; n < (over.reports ?? 1); n++) nextReport(id);
  };
  const row = (id: string) => db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(id) as any;
  const setState = (id: string, state: string) => { db.prepare(`UPDATE managed_threads SET state=? WHERE thread_id=?`).run(state, id); store.reload(); };
  const targetRows = (reviewerId: string) =>
    db.prepare(`SELECT worker_thread_id, report_seq, head_sha, pr_url, branch FROM review_targets WHERE reviewer_thread_id=? ORDER BY worker_thread_id`).all(reviewerId) as any[];
  /** review-context.md is written before the launch, to the attempt folder on the reviewer's host (host.writeArtifact), never to the reviewer's storage. */
  const contexts = () => host.writeArtifact.mock.calls.filter(([, , name]) => name.endsWith("/review-context.md")).map(([, , , content]) => content);
  return {
    db, store, ledger, review, chief, managedSpawn, launches, events, forge, host, worker, nextReport, row, setState, targetRows, contexts,
    covering: (ids: string[]) => { covers = ids; },
  };
}

const headOf = (branch: string, sha = SHA_B): PinnedHead => ({ branch, sha, base: "main" });

describe("identity: the gate pins each target's report and head once", () => {
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

    expect(w.row("R1")).toMatchObject({ reviewed_head_sha: SHA_B });
    expect(w.targetRows("R1")).toEqual([{ worker_thread_id: "W1", report_seq: 2, head_sha: SHA_B, pr_url: pr(1), branch: "feature/one" }]);
    expect(w.store.gate("task:W1")!.targets).toMatchObject([{ threadId: "W1", reportSeq: 2, headSha: SHA_B }]);
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

    expect(out).toMatchObject({ threadId: "R1", created: true });
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(2); // the reviewer and the tester
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

    expect(out).toMatchObject({ threadId: "R1", created: true });
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(2);
    expect(w.targetRows("R1")).toHaveLength(1);
    expect(w.contexts()[0]).toContain("Skipped: deadline (30 s) passed.");
  });
});

describe("review-context.md: written before the launch; a failed write inlines the context and never undoes the launch", () => {
  const withHead = () => {
    const w = world({ heads: { [pr(1)]: headOf("feature/one") } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    return w;
  };
  const failContext = (w: ReturnType<typeof world>, fail: () => Promise<string> = () => Promise.reject(new Error("disk full"))) => w.host.writeArtifact.mockImplementation(fail as any);
  const FOLDER = /^review-1\/([0-9a-f]{8})\/review-context\.md$/;
  const MESSAGE = (name: string, error: string) => `Could not write ${name} for the review of W1 after 3 attempts: ${error}. The context is inlined into the reviewer prompt instead.`;
  const nameOf = (w: ReturnType<typeof world>) => w.host.writeArtifact.mock.calls[0]![2];

  test("the context is written, and the prompt names the returned absolute path, before the reviewer is launched", async () => {
    const w = withHead();

    await w.review.startReview(w.chief, "W1");

    expect(w.events).toEqual([`artifact:${nameOf(w)}`, "launch", "launch"]);
    expect(nameOf(w)).toMatch(FOLDER);
    const path = `/data/host_proj/chief/proj/W1/${nameOf(w)}`;
    const prompt: string = w.launches[0]!.args.prompt;
    expect(prompt).toContain(`Read \`${path}\` in full before reviewing: it holds the reports, plan files and pointers this brief names.`);
    expect(prompt).not.toContain("## review-context.md");
    expect(w.host.alertChief).not.toHaveBeenCalled();
    // The path the prompt names is the one the host returned: a prompt can never name a file that was not written.
    w.host.writeArtifact.mockClear();
    const other = world({ heads: { [pr(1)]: headOf("feature/one") } });
    other.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    other.host.writeArtifact.mockImplementation(async () => "/elsewhere/returned/review-context.md");
    await other.review.startReview(other.chief, "W1");
    expect(other.launches[0]!.args.prompt).toContain("Read `/elsewhere/returned/review-context.md` in full before reviewing");
  });

  test("3 attempts on a 1 s and 2 s backoff before the launch, then one Chief alert; the launch still happens with the context inlined; the reply is unchanged", async () => {
    const w = withHead();
    failContext(w);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.host.writeArtifact).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(w.host.writeArtifact).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.host.writeArtifact).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(w.host.writeArtifact).toHaveBeenCalledTimes(2);
    // The reviewer does not start while a context write is still being retried.
    expect(w.managedSpawn.launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = await run;

    expect(w.host.writeArtifact).toHaveBeenCalledTimes(3);
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(2); // the reviewer and the tester
    expect(w.host.alertChief).toHaveBeenCalledTimes(1);
    const name = nameOf(w);
    expect(name).toMatch(FOLDER);
    expect(new Set(w.host.writeArtifact.mock.calls.map(([, , written]) => written))).toEqual(new Set([name]));
    const [alertRow, key, message] = w.host.alertChief.mock.calls[0]!;
    expect(alertRow.thread_id).toBe("W1"); // the reviewer's row does not exist before the launch: the worker's names the same Chief
    expect(alertRow.chief_thread_id).toBe("chief");
    expect(key).toBe(`${name.replace(/\.md$/, "")}:W1`);
    expect(message).toBe(MESSAGE(name, "Error: disk full"));
    expect(w.host.logError).not.toHaveBeenCalled();
    expect(out).toMatchObject({ threadId: "R1", created: true });
    expect(w.targetRows("R1")).toHaveLength(1);
    // The prompt inlines the very text that failed to be written, once, under its own heading, and names no file.
    const prompt: string = w.launches[0]!.args.prompt;
    const [written] = w.host.writeArtifact.mock.calls.map(([, , , content]) => content as string);
    expect(prompt.endsWith(`\n\n## review-context.md\n${written!.replace(/\n$/, "")}`)).toBe(true);
    expect(prompt.split("## review-context.md\n")).toHaveLength(2);
    expect(prompt).not.toContain("in full before reviewing: it holds");
  });

  test("a write that throws synchronously is a failed attempt", async () => {
    const w = withHead();
    failContext(w, () => { throw new Error("sync disk"); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await run;

    expect(w.host.writeArtifact).toHaveBeenCalledTimes(3);
    expect(w.host.alertChief.mock.calls[0]![2]).toBe(MESSAGE(nameOf(w), "Error: sync disk"));
    expect(out).toMatchObject({ threadId: "R1", created: true });
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(2); // the reviewer and the tester
  });

  test("one failed attempt that then succeeds writes once, sends no alert, and names the path", async () => {
    const w = withHead();
    let calls = 0;
    w.host.writeArtifact.mockImplementation(async (threadId, projectId, name, _content, hostId) => {
      if (++calls === 1) throw new Error("blip");
      return `/data/${hostId}/chief/${projectId}/${threadId}/${name}`;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(w.host.writeArtifact).toHaveBeenCalledTimes(2);
    expect(w.host.alertChief).not.toHaveBeenCalled();
    expect(w.launches[0]!.args.prompt).toContain(`Read \`/data/host_proj/chief/proj/W1/${nameOf(w)}\` in full before reviewing`);
    expect(w.launches[0]!.args.prompt).not.toContain("## review-context.md");
  });

  test.each([
    ["rejects", () => Promise.reject(new Error("chief down"))],
    ["throws synchronously", () => { throw new Error("chief down"); }],
  ])("a Chief alert that %s is logged with the original message, never thrown", async (_name, fail) => {
    const w = withHead();
    failContext(w);
    w.host.alertChief.mockImplementation(fail as any);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const run = w.review.startReview(w.chief, "W1");
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await run;

    expect(w.host.alertChief).toHaveBeenCalledTimes(1);
    expect(w.host.logError).toHaveBeenCalledTimes(1);
    expect(w.host.logError).toHaveBeenCalledWith(`${MESSAGE(nameOf(w), "Error: disk full")} The Chief alert also failed: Error: chief down`);
    expect(out).toMatchObject({ threadId: "R1", created: true });
    expect(w.managedSpawn.launch).toHaveBeenCalledTimes(2); // the reviewer and the tester
  });

  test("a branch review has no context: nothing is written, and the prompt has no read line and no inline section", async () => {
    const w = world({ projectPath: "/checkout", heads: { [pr(9)]: headOf("feature/from-head") } });

    await w.review.startBranchReview(w.chief, { pullRequest: pr(9) });

    expect(w.host.writeArtifact).not.toHaveBeenCalled();
    expect(w.host.writeFile).not.toHaveBeenCalled();
    expect(w.launches[0]!.args.prompt).not.toContain("in full before reviewing: it holds");
    expect(w.launches[0]!.args.prompt).not.toContain("## review-context.md");
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

    await w.review.startReview(w.chief, "W1"); // real timers: it must not wait for the cleanup or the 30 s deadline

    expect(pointersPerTarget(w.contexts()[0])).toEqual([20]);
  }, 20_000);
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

describe("engine modes: the section and the wrapper reach the reviewer", () => {
  const DIR = "/opt/my pr-agent";
  const engineOf = (mode: "pr-agent" | "both") => async () => ({ mode, prAgentDir: DIR });
  const writesOf = (w: ReturnType<typeof world>) => w.host.writeFile.mock.calls.map(([, relPath]) => relPath);
  /** Wave 1: review-context.md is an attempt-folder artifact on the reviewer's host, so the reviewer's own storage gets no write at all. */
  const CONTEXT = "review-context.md";
  /** A fresh attempt id per start: the same bytes of two starts differ only in it. */
  const sameAttempt = (text: string) => text.replace(/review-(\d+)\/[0-9a-f]{8}\//g, "review-$1/<attempt>/");
  /** Engine files go to Chief's data folder under `review-<report number>/<attempt id>/`; the names are given relative to that folder. */
  const ATTEMPT = /^review-\d+\/[0-9a-f]{8}\//;
  /** The engine files only: the context artifact every start writes is asserted on its own. */
  const artifactsOf = (w: ReturnType<typeof world>) => w.host.writeArtifact.mock.calls.map(([, , name]) => name.replace(ATTEMPT, "")).filter((name) => name !== CONTEXT);
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
    return { prompt: sameAttempt(w.launches[0]!.args.prompt as string), context: w.contexts()[0] };
  }
  const pinnedOne = (w: ReturnType<typeof world>) => w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
  const heads1 = { [pr(1)]: headOf("feature/one") };

  test("pr-agent, one pinned target: the prompt is the reviewer prompt plus the section, the wrapper (with the configured directory) sits in Chief's folder at the literal path the prompt names", async () => {
    const base = await plain(pinnedOne, heads1);
    const w = world({ heads: heads1, engine: engineOf("pr-agent") });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    const prompt: string = w.launches[0]!.args.prompt;
    expect(sameAttempt(prompt).startsWith(`${base.prompt}\n## Review engine: pr-agent\n`)).toBe(true);
    expect(prompt).toContain(`- worker W1 (branch feature/one): ${pr(1)} pinned to ${SHA_B} → pr-agent`);
    const FOLDER = folderOf(w);
    expect(prompt).toContain(`bash "${FOLDER}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`);
    expect(executedLines(prompt)).toEqual([`bash "${FOLDER}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`]);
    expect(prompt).not.toContain("$BB_THREAD_STORAGE/pr-agent-review.sh");
    expect(artifactsOf(w)).toEqual(["pr-agent-review.sh"]);
    expect(w.host.writeArtifact.mock.calls[0]!.slice(0, 2)).toEqual(["W1", "proj"]);
    expect(writesOf(w)).toEqual([]);
    expect(w.contexts()).toEqual([base.context]);
    const script = artifactOf(w, "pr-agent-review.sh")!;
    expect(script.startsWith("#!")).toBe(true);
    expect(script).toContain(DIR);
    expect(w.host.alertChief).not.toHaveBeenCalled();
  });

  test("both: the helper prompt is the reviewer-mode prompt (never the engine prompt) plus the context", async () => {
    const base = await plain(pinnedOne, heads1);
    const w = world({ heads: heads1, engine: engineOf("both") });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    expect(artifactsOf(w)).toEqual(["pr-agent-review.sh", "review-helper.md"]);
    expect(writesOf(w)).toEqual([]);
    const helper = sameAttempt(artifactOf(w, "review-helper.md")!);
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

  test.each(["pr-agent", "both"] as const)("%s: the context and the engine files are written, in that order, before the reviewer is spawned", async (mode) => {
    const w = world({ heads: heads1, engine: engineOf(mode) });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    const folder = folderOfStart(w.host.writeArtifact.mock.calls as any);
    expect(w.events).toEqual([
      `artifact:${folder}/review-context.md`,
      `artifact:${folder}/pr-agent-review.sh`,
      ...(mode === "both" ? [`artifact:${folder}/review-helper.md`] : []),
      "launch", "launch",
    ]);
  });

  test("the folder is keyed by the reviewed report number", async () => {
    const w = world({ heads: heads1, engine: engineOf("pr-agent") });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one", reports: 3 });

    await w.review.startReview(w.chief, "W1");

    const folder = folderOfStart(w.host.writeArtifact.mock.calls as any);
    expect(folder).toMatch(/^review-3\//);
    expect(w.host.writeArtifact.mock.calls.map(([, , name]) => name)).toEqual([`${folder}/review-context.md`, `${folder}/pr-agent-review.sh`]);
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

  test("an engine read that rejects is the reviewer-mode prompt and files, and one log line", async () => {
    const base = await plain(pinnedOne, heads1);
    const w = world({ heads: heads1, engine: () => Promise.reject(new Error("store down")) });
    pinnedOne(w);

    await w.review.startReview(w.chief, "W1");

    expect(sameAttempt(w.launches[0]!.args.prompt)).toBe(base.prompt);
    expect(artifactsOf(w)).toEqual([]);
    expect(w.contexts()).toHaveLength(1);
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
      const w = world({ heads: mixed ? { [pr(1)]: headOf("feature/one"), [pr(2)]: headOf("feature/two", SHA_A) } : heads1, engine: engineOf(mode) });
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
      expect(attempts(w, "review-context.md")).toBe(1);
      expect(sameAttempt(w.launches[0]!.args.prompt)).toBe(base.prompt);
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
    // reviewer does the direct half itself: a direct review of EVERY target (definitive pr-agent outcomes included) combined with
    // the pr-agent outcomes. Regression: dropping the both-mode obligation with the helper lets a definitive pr-agent result stand in for the review.
    // The plan has two pinned targets so a direct half limited to one of them fails too.
    test("both: a helper-file failure drops the helper lines and the spawn command, keeps the wrapper run, and tells the reviewer to review every target directly and combine", async () => {
      const { w } = await failing("both", ["review-helper.md"], true);

      const prompt: string = w.launches[0]!.args.prompt;
      expect(prompt).toContain("## Review engine: both");
      expect(executedLines(prompt)).toEqual([`bash "${folderOf(w)}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`, `bash "${folderOf(w)}/pr-agent-review.sh" ${pr(2)} ${SHA_A}`]);
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
        `bash "${folderOf(w)}/pr-agent-review.sh" ${pr(2)} ${SHA_A}`,
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
      const folder = folderOfStart(w.host.writeArtifact.mock.calls as any);
      expect(w.host.alertChief.mock.calls.map(([, key]) => key)).toEqual([`${folder}/review-context:W1`, expect.stringMatching(/pr-agent-review:W1$/)]);
      expect(w.host.alertChief.mock.calls[0]![2]).toBe(`Could not write ${folder}/review-context.md for the review of W1 after 3 attempts: Error: disk full. The context is inlined into the reviewer prompt instead.`);
      expect(w.host.alertChief.mock.calls[0]![0].thread_id).toBe("W1");
      expect(w.launches[0]!.args.prompt).toContain(`\n\n## review-context.md\n`);
      expect(w.launches[0]!.args.prompt).not.toContain("in full before reviewing: it holds");
    });
  });

  // Contract (docs/specs/review-engine.md, Engine folder): the folder holds a fresh attempt id for each review start, so a repeat review of the
  // same worker and report never reads another attempt's files. Regression: one folder per worker and report lets attempt 2 run attempt 1's prompt.
  describe("per-attempt engine folder", () => {
    /** One pinned worker; attempt 1's reviewer fails, so a second chief_review starts a new reviewer for the same gate (the tester stays). */
    async function twoAttempts(mode: "pr-agent" | "both", second?: (w: ReturnType<typeof world>) => void) {
      const w = world({ heads: heads1, engine: engineOf(mode) });
      pinnedOne(w);
      const first = await w.review.startReview(w.chief, "W1");
      const firstWrites = [...w.host.writeArtifact.mock.calls] as any[];
      w.setState(first.threadId, "failed");
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

      expect(out).toMatchObject({ threadId: "R3", created: true }); // R2 is the gate's tester
      const [first, second] = [folderOfStart(firstWrites), folderOfStart(secondWrites)];
      expect(first).toMatch(/^review-1\//);
      expect(second).toMatch(/^review-1\//);
      expect(second).not.toBe(first);
      const prompt: string = w.launches[2]!.args.prompt;
      expect(prompt).not.toContain(first);
      expect(prompt).toContain(`bash "/data/host_proj/chief/proj/W1/${second}/pr-agent-review.sh" ${pr(1)} ${SHA_B}`);
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
      expect(firstWrites.map(([, , name]) => name.replace(ATTEMPT, ""))).toEqual(["review-context.md", "pr-agent-review.sh", "review-helper.md"]);
      expect(secondWrites.filter(([, , name]) => name.endsWith("review-helper.md"))).toHaveLength(3);
      const prompt: string = w.launches[2]!.args.prompt;
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

      expect(hostsOf(w)).toEqual(["host_reviewer", "host_reviewer", "host_reviewer"]);
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
  });
});

// Wave 1 contracts (plan-1.md "Contracts to verify") through startReview: the doubles are the forge, the host and spawn; the project checkout is a real
// temporary Git repository wherever a slice is read, and the only thing stubbed inside Git is a lookup the test asks to fail (a `git` shim on PATH).
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
const hasLine = (text: string, line: string) => text.split("\n").includes(line);
const nativeOf = (prompt: string) => hasLine(prompt, REVIEWER_NATIVE_LINE) ? "full" : hasLine(prompt, NATIVE_NO_RESHAPE_LINE) ? "no-reshape" : prompt.includes("Native-design check") ? "garbled" : "none";

type RepoApi = { dir: string; git: (...args: string[]) => string; put: (path: string, content: string | Buffer) => void; commit: (message: string) => string };
/** `main` holds src/app.ts and `baseFiles`; origin/main points at it; `onFeature` makes the commits of branch `feature`. */
async function repoWith(baseFiles: Record<string, string | Buffer>, onFeature: (repo: RepoApi) => void) {
  const dir = mkdtempSync(join(tmpdir(), "review-start-wave1-"));
  disposals.push(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" }).trim();
  const put = (path: string, content: string | Buffer) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); };
  const commit = (message: string) => { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  git("config", "core.fileMode", "true");
  git("config", "commit.gpgsign", "false");
  put("src/app.ts", "export const app = 1;\n");
  for (const [path, content] of Object.entries(baseFiles)) put(path, content);
  const base = commit("base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "-b", "feature");
  onFeature({ dir, git, put, commit });
  return { dir, git, base, sha: git("rev-parse", "HEAD") };
}

/** Starts the review of W1 (pull request 1, head `repo.sha`) and returns what the reviewer was launched with. */
async function reviewOf(repo: { dir: string; sha: string } | null, over: { waves?: PlanWave[]; kind?: string; planWave?: number; env?: NodeJS.ProcessEnv; skip?: string } = {}) {
  const w = world({ projectPath: repo?.dir ?? null, heads: { [pr(1)]: headOf("feature/one", repo?.sha) }, waves: over.waves, gitEnv: over.env });
  if (over.skip) w.host.checkoutSkip.mockResolvedValue(over.skip);
  w.worker("W1", { prUrl: pr(1), branch: "feature/one", kind: over.kind, planWave: over.planWave });
  const out = await w.review.startReview(w.chief, "W1");
  return { w, out, prompt: w.launches[0]!.args.prompt as string, context: w.contexts()[0] as string | undefined };
}

describe("impact slice base of a stacked or branch-based plan wave", () => {
  // `main` is origin/HEAD; `develop` (origin/develop) adds src/parent.test.ts on top of it; branch feature/one adds src/x.ts on top of develop.
  // The impact-slice header of review-context.md names the base the slice used.
  async function stackedRepo() {
    const repo = await repoWith({}, (r) => {
      r.put("src/parent.test.ts", "export const parent = 1;\n"); r.commit("parent");
      r.git("update-ref", "refs/remotes/origin/develop", "HEAD");
      r.put("src/x.ts", "export const x = 1;\n"); r.commit("feature");
      r.git("update-ref", "refs/remotes/origin/feature/one", "HEAD");
    });
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    return repo;
  }
  // The gate always pins a head, so the slice base is the pinned head's base; a plan base never replaces it.
  test("a pinned head is sliced against origin/<head.base>, whatever the plan base says", async () => {
    const repo = await stackedRepo();
    const slice = async (base: string) => {
      const w = world({ projectPath: repo.dir, heads: { [pr(1)]: { branch: "feature/one", sha: repo.sha, base } }, planBaseOf: () => ({ base: "main" }) });
      w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
      await w.review.startReview(w.chief, "W1");
      return w.contexts()[0] as string;
    };
    expect(await slice("develop")).toContain("with origin/develop,");
    expect(await slice("main")).toContain("with origin/main,");
  }, 60_000);
});

describe("plan wave flags choose the native-design check", () => {
  const plan = (...waves: Array<Omit<PlanWave, "path">>): PlanWave[] => waves.map((wave, index) => ({ path: `/p/plan-${index + 1}.md`, ...wave }));
  const nativeFor = async (waves: PlanWave[]) => nativeOf((await reviewOf(null, { waves, planWave: waves.length ? 1 : undefined })).prompt);

  // Contract: `feature && reshape` is the base line; `feature && !reshape` loses the two reshape parts; `!feature` renders none. A legacy wave (no `feature` key)
  // counts as a feature and a reshape; a design wave never counts as a legacy implementation wave.
  // Regression: treating a missing key as false drops the check on every plan made before the flag; treating the test wave as an implementation wave adds the reshape sentences.
  test.each<[string, Array<Omit<PlanWave, "path">>, string]>([
    ["a legacy plan, no feature key anywhere", [{}], "full"],
    ["feature: true and reshape: true", [{ feature: true, reshape: true }], "full"],
    ["feature: true only: the two reshape parts go", [{ feature: true, reshape: false }], "no-reshape"],
    ["feature: true without a reshape key", [{ feature: true }], "no-reshape"],
    ["feature: false only: none renders", [{ feature: false, reshape: false }], "none"],
    ["feature: false and reshape: true: none renders", [{ feature: false, reshape: true }], "none"],
    ["a design wave with no keys before a feature wave", [{ design: true }, { feature: true, dependsOn: [1] }], "no-reshape"],
    ["one feature wave among feature: false waves", [{ feature: false }, { feature: true, dependsOn: [1] }], "no-reshape"],
    ["a reshape wave and a feature wave in one chain", [{ feature: false, reshape: true }, { feature: true, dependsOn: [1] }], "full"],
    ["a legacy wave next to feature: false waves", [{ feature: false, reshape: false }, { dependsOn: [1] }], "full"],
    ["unplanned work (no plan waves)", [], "no-reshape"],
  ])("%s -> %s", async (_name, waves, expected) => {
    expect(await nativeFor(plan(...waves))).toBe(expected);
  });

  test("a plan review of two workers renders the same split", async () => {
    const waves = plan({ feature: false }, { feature: false, dependsOn: [1] });
    const w = world({ waves, heads: { [pr(1)]: headOf("feature/one"), [pr(2)]: headOf("feature/two", SHA_A) } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one", planWave: 1 });
    w.worker("W2", { prUrl: pr(2), branch: "feature/two", planWave: 2 });
    w.covering(["W1", "W2"]);
    await w.review.startReview(w.chief, "W1");
    expect(nativeOf(w.launches[0]!.args.prompt)).toBe("none");
  });
});

describe("acceptedGaps through the review starters", () => {
  const GAPS = "No device run: Chief accepts the simulator evidence.";
  const block = ["## Accepted gaps (Manual Verification)", GAPS];

  test("a worker review: absent renders nothing, present renders one block right after the focus line", async () => {
    const w = world({ heads: { [pr(1)]: headOf("feature/one") } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    await w.review.startReview(w.chief, "W1", "the discount path");
    const absent: string = w.launches[0]!.args.prompt;
    expect(absent).not.toContain("Accepted gaps");

    const given = world({ heads: { [pr(1)]: headOf("feature/one") } });
    given.worker("W1", { prUrl: pr(1), branch: "feature/one" });
    await given.review.startReview(given.chief, "W1", "the discount path", GAPS);
    const prompt: string = given.launches[0]!.args.prompt;
    const lines = prompt.split("\n");
    const at = lines.indexOf("Review focus: the discount path");
    expect(lines.slice(at + 1, at + 3)).toEqual(block);
    expect(prompt.split("## Accepted gaps (Manual Verification)")).toHaveLength(2);
    // Nothing else of the prompt moved: dropping the block gives the prompt without gaps (the attempt folder differs by its id).
    const same = (text: string) => text.replace(/review-(\d+)\/[0-9a-f]{8}\//g, "review-$1/<attempt>/");
    expect(same(prompt.split("\n").filter((_, index) => index < at + 1 || index >= at + 4).join("\n"))).toBe(same(absent.replace("Review focus: the discount path\n", "Review focus: the discount path\n")));
  });

  test("a branch review carries the same block, and no block without it", async () => {
    const w = world();
    await w.review.startBranchReview(w.chief, { branch: "feature/x" }, "the discount path", GAPS);
    const lines = (w.launches[0]!.args.prompt as string).split("\n");
    expect(lines.slice(lines.indexOf("Review focus: the discount path") + 1).slice(0, 2)).toEqual(block);

    const plain = world();
    await plain.review.startBranchReview(plain.chief, { branch: "feature/y" }, "the discount path");
    expect(plain.launches[0]!.args.prompt).not.toContain("Accepted gaps");
  });
});
