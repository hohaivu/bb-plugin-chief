import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { disposeAll } from "./test/harness";
import { type GateWorld, gateWorld } from "./test/gateWorld";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(async () => { vi.useRealTimers(); await disposeAll(); });

// Contracts (plan 3, src/runtime/cleanup.ts merge proof): cleanup archives a thread, and deletes its branch, only when the forge says every
// pull request of the task is merged. Open, closed unmerged and unknown all keep the row (or the queued job) with no attempt counted and no alert.
// A merged answer is kept, any other is asked again after 5 minutes, one pass asks the forge at most 10 times, and a task with no PR keeps its timing.
const PR_A = "https://github.com/acme/shop/pull/1";
const PR_B = "https://github.com/acme/shop/pull/2";
const MIN = 60_000;

const lookupUrls = (world: GateWorld) => world.git.calls.filter((call) => call[0] === "gh" && call.includes("state,headRefOid")).map((call) => `https://github.com/${call[call.indexOf("--repo") + 1]}/pull/${call[3]}`);
const lookups = (world: GateWorld, url?: string) => lookupUrls(world).filter((asked) => !url || asked === url).length;
const jobs = (world: GateWorld) => world.state.db.prepare(`SELECT thread_id, step, attempts, outcome FROM cleanup_jobs ORDER BY rowid`).all() as { thread_id: string; step: string; attempts: number; outcome: string | null }[];
const jobOf = (world: GateWorld, id: string) => jobs(world).find((job) => job.thread_id === id);
const cleanupAlerts = (world: GateWorld) => (world.state.db.prepare(`SELECT COUNT(*) AS n FROM alert_outbox WHERE dedupe_key LIKE '%cleanup-%'`).get() as { n: number }).n;
const cycle = (world: GateWorld) => world.state.supervisorCycle();
/** Only the clock is faked, so the 5 minute re-ask can be crossed without waiting. */
const clock = () => { vi.useFakeTimers({ toFake: ["Date"] }); return (ms: number) => vi.setSystemTime(Date.now() + ms); };

/** bb's archive: a thread with nothing live under it is archived at once. */
function archiveWorks(world: GateWorld) {
  world.state.harness.sdk.stub("threads.childSummary", async () => ({ unarchivedDescendantCount: 0 }));
  world.state.harness.sdk.stub("threads.archive", async ({ threadId }: { threadId: string }) => {
    world.state.archivedThreads.push(threadId);
    world.state.live.set(threadId, { ...world.state.live.get(threadId)!, archivedAt: Date.now() } as any);
    return { ok: true, archivedThreadIds: [threadId] };
  });
}

/** A worker whose gate passed and that is complete: cleanup_approved_at is stamped, so it, its reviewer and its advisors are eligible. */
async function finished(world: GateWorld, prUrl?: string) {
  const gated = await world.passed("Fix", prUrl ? { prUrl } : {});
  await world.complete(gated.worker.threadId);
  return gated;
}

describe("cleanup waits for the forge to say merged", () => {
  test("an open PR enqueues nothing; a closed one too; once merged (after the re-ask time) the worker and its reviewer are enqueued", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker, reviewer } = await finished(world, PR_A);
    const advance = clock();
    archiveWorks(world);
    expect(world.row(worker.threadId).cleanup_approved_at).not.toBeNull();
    world.git.prStates.set(PR_A, "OPEN");
    await cycle(world);
    expect(jobs(world)).toEqual([]);
    world.git.prStates.set(PR_A, "CLOSED");
    advance(6 * MIN);
    await cycle(world);
    expect(jobs(world)).toEqual([]);
    expect(cleanupAlerts(world)).toBe(0);
    world.git.prStates.set(PR_A, "MERGED");
    advance(6 * MIN);
    await cycle(world);
    expect(jobOf(world, worker.threadId)).toMatchObject({ attempts: 0 });
    expect(jobOf(world, reviewer)).toMatchObject({ attempts: 0 });
    expect(world.state.archivedThreads).toEqual(expect.arrayContaining([worker.threadId, reviewer]));
  });

  test("a preexisting queued archive job whose PR is open is not archived; after the forge says merged it runs", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker } = await finished(world, PR_A);
    const advance = clock();
    archiveWorks(world);
    const now = Date.now();
    world.state.db.prepare(`INSERT INTO cleanup_jobs (thread_id, chief_thread_id, project_id, step, step_at, created_at, updated_at) VALUES (?, ?, 'proj_1', 'archive', ?, ?, ?)`)
      .run(worker.threadId, world.chief, now, now, now);
    world.git.prStates.set(PR_A, "OPEN");
    await cycle(world);
    expect(jobOf(world, worker.threadId)).toMatchObject({ step: "archive", attempts: 0, outcome: null });
    expect(world.state.archivedThreads).not.toContain(worker.threadId);
    expect(cleanupAlerts(world)).toBe(0);
    world.git.prStates.set(PR_A, "MERGED");
    advance(6 * MIN);
    await cycle(world);
    expect(world.state.archivedThreads).toContain(worker.threadId);
    expect(jobOf(world, worker.threadId)).toMatchObject({ step: "storage", attempts: 0 });
  });

  test("a reviewer that covers two PRs, one merged and one open, is kept; the merged PR's own worker is not", async () => {
    const world = await gateWorld({ cleanup: true });
    const first = await finished(world, PR_A);
    // The second covered worker: complete, approved for cleanup, its PR recorded on the reviewer's target row.
    const second = await world.worker("Second wave", { prUrl: PR_B });
    world.state.db.prepare(`UPDATE managed_threads SET state='complete', cleanup_approved_at=? WHERE thread_id=?`).run(Date.now(), second.threadId);
    world.state.db.prepare(`INSERT INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha, pr_url, branch) VALUES (?, ?, 1, ?, ?, ?)`)
      .run(first.reviewer, second.threadId, "a".repeat(40), PR_B, second.branch);
    world.git.prStates.set(PR_A, "MERGED");
    world.git.prStates.set(PR_B, "OPEN");
    await cycle(world);
    expect(jobOf(world, first.worker.threadId)).toMatchObject({ step: "archive" });
    expect(jobOf(world, first.reviewer)).toBeUndefined();
    expect(jobOf(world, second.threadId)).toBeUndefined();
  });

  test("a PR the forge cannot answer for keeps the row, and is asked again no sooner than 5 minutes later", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker } = await finished(world, PR_A);
    const advance = clock();
    world.git.prStates.set(PR_A, "fail");
    await cycle(world);
    expect(lookups(world, PR_A)).toBe(1);
    expect(jobs(world)).toEqual([]);
    advance(4 * MIN);
    await cycle(world);
    expect(lookups(world, PR_A)).toBe(1);
    world.git.prStates.set(PR_A, "MERGED");
    advance(MIN + 1_000);
    await cycle(world);
    expect(lookups(world, PR_A)).toBe(2);
    expect(jobOf(world, worker.threadId)).toMatchObject({ step: "archive" });
    expect(cleanupAlerts(world)).toBe(0);
  });

  test("a merged PR is looked up once, however many threads, jobs and passes depend on it", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker, reviewer } = await finished(world, PR_A);
    world.git.prStates.set(PR_A, "MERGED");
    await cycle(world);
    await cycle(world);
    await cycle(world);
    expect(jobOf(world, worker.threadId)).toBeDefined();
    expect(jobOf(world, reviewer)).toBeDefined();
    expect(lookups(world, PR_A)).toBe(1);
  });

  test("one pass asks the forge at most 10 times; the rest wait for the next pass", async () => {
    const world = await gateWorld({ cleanup: true });
    const urls: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const url = `https://github.com/acme/shop/pull/${100 + i}`;
      urls.push(url);
      const worker = await world.worker(`Task ${i}`, { prUrl: url });
      world.state.db.prepare(`UPDATE managed_threads SET state='complete', cleanup_approved_at=? WHERE thread_id=?`).run(Date.now(), worker.threadId);
    }
    world.git.prState = "OPEN";
    await cycle(world);
    expect(lookups(world)).toBe(10);
    await cycle(world); // the ten answers are fresh (under 5 minutes): only the two never asked are looked up
    expect(lookups(world)).toBe(12);
    expect(new Set(lookupUrls(world)).size).toBe(12);
    expect(jobs(world)).toEqual([]);
  });

  test("a task with no PR keeps its timing: enqueued at once, with no forge call", async () => {
    const world = await gateWorld({ cleanup: true });
    const { worker, reviewer } = await finished(world);
    await cycle(world);
    expect(jobOf(world, worker.threadId)).toMatchObject({ step: "archive" });
    expect(jobOf(world, reviewer)).toMatchObject({ step: "archive" });
    expect(lookups(world)).toBe(0);
  });
});
