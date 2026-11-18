import { vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "../src/db/migrations";
import type { ManagedRow } from "../src/types";
import { createReviewLedger } from "../src/review/reviewLedger";
import { createReviewStart, type PinnedHead } from "../src/review/reviewStart";
import type { PlanWave } from "../src/plan/waveSchedule";
import { createWaveSchedule } from "../src/plan/waveSchedule";
import { createPlanProgress } from "../src/plan/planProgress";
import { createThreadStore } from "../src/db/threadStore";

// A standalone review attempt over real SQLite and the real ThreadStore; only the host, the forge and spawn are doubles.
// Shared by reviewStart.test.ts and gateOpen.test.ts. Each test file registers its own afterEach that drains `disposals`.
export const disposals: Array<() => Promise<void>> = [];

export const SHA_B = "b".repeat(40);
export const SHA_A = "a".repeat(40);
export const pr = (n: number) => `https://github.com/acme/shop/pull/${n}`;
const BUSY = new Set(["active", "starting", "stopping", "pending"]);

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

let worlds = 0;
/** realPlan: plan P is a real planner row holding `waves`, and the plan deps are the real wave schedule and plan progress (gate actors hidden as in production), not stubs. */
export type Options = { realPlan?: boolean; projectPath?: string | null; heads?: Record<string, PinnedHead | null>; engine?: () => unknown; waves?: PlanWave[]; gitEnv?: NodeJS.ProcessEnv; planBaseOf?: (row: ManagedRow) => { base: string } | { skipped: string } | null };

/** A standalone review attempt over real SQLite and the real ThreadStore; only the host, the forge and spawn are doubles. */
export function world({ realPlan = false, projectPath = null, heads = {}, engine, waves = [], gitEnv, planBaseOf }: Options = {}) {
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
  const gateActor = (row: ManagedRow) => row.plan_wave == null && store.isGateActor(row.thread_id);
  const schedule = createWaveSchedule<ManagedRow>(store.rows, gateActor);
  const progress = createPlanProgress<ManagedRow>(store.rows, schedule, ledger, { terminal: (state) => ["complete", "archived", "deleted"].includes(state), busy: (status) => BUSY.has(status) });
  if (realPlan) {
    store.insert({ threadId: "P", role: "planner", projectId: "proj", chiefThreadId: "chief", title: "Plan P", state: "ready", status: "idle" });
    db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id='P'`).run(JSON.stringify(waves));
    store.reload();
  }
  const review = createReviewStart<ManagedRow>({
    db, store, ledger, managedSpawn: managedSpawn as any,
    plan: realPlan ? {
      reviewRefusal: (worker) => { const block = progress.reviewBlock(worker); return block ? `The review is blocked: ${block.kind}.` : null; },
      reviewTargetsFor: schedule.reviewTargetsFor, planWavesFor: schedule.planWavesFor, planBaseOf: schedule.planBaseOf,
      specWriters: schedule.specWriters, taskWriters: schedule.taskWriters,
    } : {
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
    db, store, ledger, schedule, progress, review, chief, managedSpawn, launches, events, forge, host, worker, nextReport, row, setState, targetRows, contexts,
    covering: (ids: string[]) => { covers = ids; },
  };
}

export const headOf = (branch: string, sha = SHA_B): PinnedHead => ({ branch, sha, base: "main" });

