import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { disposals, headOf, pr, SHA_A, SHA_B, world } from "./reviewWorld";
import { createWaveSchedule, type PlanWave } from "../src/plan/waveSchedule";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

vi.mock("node:child_process", async (importOriginal) => (await import("./execMock")).builderPassMock(await importOriginal()));

provideSdk(sdkTesting);

// Contract (plan-4 steps A, B, E; plan-5 step 2): chief_review opens ONE review gate per plan (`plan:<planner>`), pins every target's head once,
// then starts one reviewer in its own fresh worktree. A second call starts nothing; only a missing or failed reviewer is
// launched again. The pin comes from the forge's pull request head, else `git ls-remote origin`; the builder's checkout must be clean and
// contained in the pin. The doubles are the forge, the host and spawn; the real parts are SQLite, the ThreadStore, the wave schedule and plan progress,
// and (for the no-PR pin and the builder check) temporary Git repositories.

afterEach(async () => {
  while (disposals.length) await disposals.pop()!();
});

const KEY = "plan:P";
const TWO_CHAINS: PlanWave[] = [{ path: "/p/plan-1.md" }, { path: "/p/plan-2.md", dependsOn: [] }];

/** A plan of two parallel chains, one ready worker each, every head on a pull request. */
function twoChains(over: { waves?: PlanWave[] } = {}) {
  const w = world({ realPlan: true, waves: over.waves ?? TWO_CHAINS, heads: { [pr(1)]: headOf("feature/one", SHA_A), [pr(2)]: headOf("feature/two", SHA_B) } });
  w.worker("W1", { prUrl: pr(1), branch: "feature/one", planWave: 1 });
  w.worker("W2", { prUrl: pr(2), branch: "feature/two", planWave: 2 });
  return w;
}
const gateRows = (w: ReturnType<typeof world>) => w.db.prepare(`SELECT * FROM review_gates`).all() as any[];

describe("one gate per plan", () => {
  // Contract: two chains, two pinned targets, one reviewer, in one review_gates row keyed plan:<planner>.
  // Regression: a gate per target (two reviewers), or a gate keyed by the worker that made the call.
  test("a two-chain plan opens one gate with both targets pinned and one reviewer", async () => {
    const w = twoChains();
    const out = await w.review.startReview(w.chief, "W1");

    const gates = gateRows(w);
    expect(gates).toHaveLength(1);
    expect(gates[0].gate_key).toBe(KEY);
    expect(JSON.parse(gates[0].targets)).toEqual([
      { threadId: "W1", reportSeq: 1, branch: "feature/one", prUrl: pr(1), headSha: SHA_A, base: "main" },
      { threadId: "W2", reportSeq: 1, branch: "feature/two", prUrl: pr(2), headSha: SHA_B, base: "main" },
    ]);
    expect(w.launches.map((launch) => launch.row.role)).toEqual(["reviewer"]);
    expect(gates[0].reviewer_thread_id).toBe(w.reviewerLaunch()!.id);
    expect(gates[0].tester_thread_id).toBeNull();
    expect(out).toMatchObject({ created: true, threadId: w.reviewerLaunch()!.id });
    expect(w.targetRows(w.reviewerLaunch()!.id).map((target) => [target.worker_thread_id, target.report_seq, target.head_sha])).toEqual([["W1", 1, SHA_A], ["W2", 1, SHA_B]]);
  });

  // Contract: the same call from either chain's worker is the same gate.
  // Regression: the second chain's call opens a second gate and a second reviewer.
  test("a call from the other chain's worker opens nothing new and names the live reviewer", async () => {
    const w = twoChains();
    await w.review.startReview(w.chief, "W1");
    const reviewer = w.reviewerLaunch()!.id;
    const again = await w.review.startReview(w.chief, "W2");

    expect(w.launches).toHaveLength(1);
    expect(gateRows(w)).toHaveLength(1);
    expect(again).toMatchObject({ created: false, threadId: reviewer });
    expect(again.reply).toContain(KEY);
    expect(again.reply).toContain(reviewer);
  });

  // Contract: the reviewer is launched in a fresh managed worktree cut from the first target's branch, never in the builder's environment.
  // Regression: the reviewer reuses the builder's environment (the removed builder-environment launch), or a stored reviewer environment.
  test("the reviewer gets a fresh managed worktree on the first target's branch, not the builder's environment", async () => {
    const w = twoChains();
    await w.review.startReview(w.chief, "W1");

    for (const launch of w.launches) {
      expect(launch.args.environment).toEqual({ type: "host", hostId: "host_proj", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/one" } } });
    }
    expect(w.host.reusableEnvironment).not.toHaveBeenCalled();
    expect(w.managedSpawn.prepare.mock.calls.map(([, pick]) => (pick as any).role)).toEqual(["reviewer"]);
  });

  // Contract: the heads are pinned once at open; a retry reviews the pinned heads, whatever the forge says now.
  // Regression: a retry re-reads the forge and reviews a moved head, or re-pins and changes the gate.
  test("live sides keep their pins; a reviewer relaunch refreshes only the target heads", async () => {
    const w = twoChains();
    await w.review.startReview(w.chief, "W1");
    const initial = w.store.gate(KEY)!.targets;
    const fresh = ["c".repeat(40), "d".repeat(40)];
    w.forge.head.mockImplementation(async (url) => url === pr(1) ? headOf("feature/one", fresh[0]!) : headOf("feature/two", fresh[1]!));
    await w.review.startReview(w.chief, "W1");
    expect(w.store.gate(KEY)!.targets).toEqual(initial);
    expect(w.launches).toHaveLength(1);

    w.setState(w.reviewerLaunch()!.id, "failed");
    await w.review.startReview(w.chief, "W1");
    expect(w.store.gate(KEY)!.targets).toEqual(initial.map((target, i) => ({ ...target, headSha: fresh[i] })));
    expect(w.targetRows(w.launches[1]!.id).map((target) => target.head_sha)).toEqual(fresh);
  });
});

describe("a horizontal plan's gate", () => {
  // Contract: contract wave 1, blocks 2 and 3 stacked on it, integrate wave 4 on block 2 share one gate whose first target, the owner of its one
  // fix run, is the integrate worker, whichever worker opened the gate; block 3 stays a pinned target and the completed block 2 drops out.
  // Regression: wave order puts the contract worker first, so a wiring fix is admitted only on the contract branch.
  test("the integrate worker leads the pinned targets, whoever opens the gate", async () => {
    const waves: PlanWave[] = [{ path: "/p/plan-1.md" }, { path: "/p/plan-2.md", dependsOn: [], stackOn: 1 }, { path: "/p/plan-3.md", dependsOn: [], stackOn: 1 }, { path: "/p/plan-4.md", dependsOn: [2] }];
    const w = world({ realPlan: true, waves, heads: Object.fromEntries([1, 2, 3, 4].map((n) => [pr(n), headOf(`feature/w${n}`, SHA_A)])) });
    for (const n of [1, 2, 3, 4]) w.worker(`W${n}`, { prUrl: pr(n), branch: `feature/w${n}`, planWave: n });
    w.setState("W2", "complete");
    expect(w.schedule.reviewTargetsFor(w.store.get("W3")!).map((row) => row.thread_id)).toEqual(["W4", "W1", "W3"]);
    await w.review.startReview(w.chief, "W3");
    expect(JSON.parse(gateRows(w)[0].targets).map((target: { threadId: string }) => target.threadId)).toEqual(["W4", "W1", "W3"]);
  });

  // Contract: only the horizontal shape (two or more heads stacked on one wave) moves the integrate worker first; a stacked chain with a
  // single stacked head keeps wave order, so a defect in wave 1 still gets its fix on wave 1.
  // Regression: any stacked chain reorders, and the gate admits its one fix run on wave 3 instead of wave 1.
  test("a plan with one stacked chain keeps wave order and its first target", async () => {
    const waves: PlanWave[] = [{ path: "/p/plan-1.md" }, { path: "/p/plan-2.md", dependsOn: [], stackOn: 1 }, { path: "/p/plan-3.md", dependsOn: [2] }];
    const w = world({ realPlan: true, waves, heads: Object.fromEntries([1, 2, 3].map((n) => [pr(n), headOf(`feature/w${n}`, SHA_A)])) });
    for (const n of [1, 2, 3]) w.worker(`W${n}`, { prUrl: pr(n), branch: `feature/w${n}`, planWave: n });
    w.setState("W2", "complete");
    await w.review.startReview(w.chief, "W3");
    expect(JSON.parse(gateRows(w)[0].targets).map((target: { threadId: string }) => target.threadId)).toEqual(["W1", "W3"]);
  });
});

describe("retry launches the reviewer only when it is missing", () => {
  // Contract: a failed (or blocked) reviewer is launched again.
  // Regression: the retry leaves the gate without a reviewer.
  test.each(["failed", "blocked", "archived"])("a %s reviewer: only a reviewer starts", async (state) => {
    const w = twoChains();
    await w.review.startReview(w.chief, "W1");
    w.setState(w.reviewerLaunch()!.id, state);
    const out = await w.review.startReview(w.chief, "W2");

    expect(w.launches).toHaveLength(2);
    expect(w.launches[1]!.row.role).toBe("reviewer");
    expect(out).toMatchObject({ created: true, threadId: w.launches[1]!.id });
    expect(w.store.gate(KEY)).toMatchObject({ reviewer_thread_id: w.launches[1]!.id, tester_thread_id: null });
  });

  // Contract: a reviewer launch that throws leaves the gate open and pinned with no actor; the next call starts the reviewer on the same pins.
  // Regression: the retry opens a second gate, or pins again.
  test("a reviewer launch that fails: the retry starts only the reviewer on the same pins", async () => {
    const w = twoChains();
    const launch = w.managedSpawn.launch.getMockImplementation()!;
    let allowReviewer = false;
    w.managedSpawn.launch.mockImplementation((prepared, args, row, commit) => row.role === "reviewer" && !allowReviewer
      ? Promise.reject(new Error("no capacity")) : launch(prepared, args, row, commit));
    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow("no capacity");
    expect(w.store.gate(KEY)).toMatchObject({ reviewer_thread_id: null, tester_thread_id: null });
    expect(w.launches).toHaveLength(0);
    const pinned = w.forge.head.mock.calls.length;

    allowReviewer = true;
    await w.review.startReview(w.chief, "W1");
    expect(w.launches).toHaveLength(1);
    expect(gateRows(w)).toHaveLength(1);
    expect(w.forge.head).toHaveBeenCalledTimes(pinned + 2);
  });
});

describe("a plan that is not whole refuses to open", () => {
  const refused = (w: ReturnType<typeof world>) => {
    expect(w.launches).toHaveLength(0);
    expect(gateRows(w)).toHaveLength(0);
  };

  // Contract: one review covers the whole plan once every wave is ready.
  // Regression: a gate opens over the ready chain only, and the other chain is never reviewed or tested.
  test("a wave not delegated yet", async () => {
    const w = world({ realPlan: true, waves: TWO_CHAINS, heads: { [pr(1)]: headOf("feature/one", SHA_A) } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one", planWave: 1 });
    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(/blocked: pending/);
    refused(w);
  });

  test("a wave whose worker is still working", async () => {
    const w = twoChains();
    w.setState("W2", "active");
    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(/blocked: pending/);
    refused(w);
  });

  // Contract: a Spec Writer that is owed or not ready holds the review back; once ready it is a target of the same gate.
  // Regression: the gate opens over a plan whose docs are unwritten, or never covers the writer's pinned head.
  test("an unready Spec Writer refuses; a ready one becomes a pinned target", async () => {
    const w = world({ realPlan: true, waves: [{ path: "/p/plan-1.md", spec: true }], heads: { [pr(1)]: headOf("feature/one", SHA_A), [pr(3)]: headOf("feature/docs", SHA_B) } });
    w.worker("W1", { prUrl: pr(1), branch: "feature/one", planWave: 1 });
    w.worker("SW", { prUrl: pr(3), branch: "feature/docs", planWave: 1, kind: "spec-writer" });
    w.setState("SW", "active");
    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(/blocked: writers/);
    refused(w);

    w.setState("SW", "ready");
    await w.review.startReview(w.chief, "W1");
    expect(w.store.gate(KEY)!.targets.map((target) => [target.threadId, target.headSha])).toEqual([["W1", SHA_A], ["SW", SHA_B]]);
  });
});

describe("wave scheduling does not see the gate's actor rows", () => {
  /** Every answer the plan makes about its waves, as plain data. */
  const answers = (w: ReturnType<typeof twoChains>) => {
    const { schedule, progress, store } = w;
    const ids = (rows: Array<{ thread_id: string } | undefined>) => rows.map((row) => row?.thread_id ?? null);
    const waves = schedule.planWavesFor("P");
    const first = store.get("W1")!;
    return {
      waves,
      pending: schedule.pendingWaves("P", waves),
      latest: ids([schedule.latestWorker("P", 1), schedule.latestWorker("P", 2)]),
      owners: ids([schedule.chainOwner("P", waves, 1), schedule.chainOwner("P", waves, 2)]),
      workers: ids(schedule.waveWorkers("P")),
      writers: ids(schedule.specWriters("P")),
      targets: ids(schedule.reviewTargetsFor(first)),
      undelegated: schedule.undelegatedHeads("P", waves),
      final: [schedule.onFinalWave(first), schedule.onFinalWave(store.get("W2")!)],
      block: progress.reviewBlock(first),
    };
  };

  // Contract: planWavesFor, pendingWaves, latestWorker, chainOwner, reviewTargetsFor and reviewBlock answer the same with a gate's fixer
  // row present as without it.
  // Regression: the fixer becomes a wave worker (a third review target, a latest worker, a plan that is no longer fully delegated).
  test("the same answers before the gate opens, with its reviewer, and with a fixer", async () => {
    const w = twoChains();
    const before = answers(w);
    expect(before.targets).toEqual(["W1", "W2"]);
    expect(before.block).toBeNull();

    await w.review.startReview(w.chief, "W1");
    expect(answers(w)).toEqual(before);

    w.store.insert({ threadId: "F1", role: "worker", projectId: "proj", chiefThreadId: "chief", title: "Fix F1", state: "ready", status: "idle", kind: "worker", planThreadId: "P", branch: "feature/one" });
    w.store.batch(() => w.store.setGateActor(KEY, "fixer_thread_id", "F1"));
    w.store.reload();
    expect(answers(w)).toEqual(before);
    // Control: a schedule that does not hide gate actors does see the fixer, so the comparison above can fail.
    expect(createWaveSchedule(w.store.rows).waveWorkers("P").map((row) => row.thread_id)).toContain("F1");
  });
});

// A real origin, the project's clone and the builder's own clone on the target's branch.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

function remote(branches: string[] = ["feature/one"]) {
  const root = mkdtempSync(join(tmpdir(), "gate-open-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  run(root, "init", "-q", "--bare", "-b", "main", bare);
  run(seed, "init", "-q", "-b", "main");
  run(seed, "config", "commit.gpgsign", "false");
  const commit = (message: string) => { writeFileSync(join(seed, "f.txt"), `${message}\n`); run(seed, "add", "-A"); run(seed, "commit", "-q", "-m", message); };
  commit("base");
  run(seed, "remote", "add", "origin", bare);
  run(seed, "push", "-q", "origin", "main");
  for (const branch of branches) { run(seed, "checkout", "-q", "-b", branch, "main"); commit(`work on ${branch}`); run(seed, "push", "-q", "origin", branch); }
  const project = join(root, "project");
  run(root, "clone", "-q", bare, project);
  const clone = (name: string, branch: string) => { const dir = join(root, name); run(root, "clone", "-q", "-b", branch, bare, dir); run(dir, "config", "commit.gpgsign", "false"); return dir; };
  return { root, bare, project, clone, tip: (branch: string) => run(bare, "rev-parse", `refs/heads/${branch}`) };
}

/** An unplanned worker with no pull request on branch feature/one; its environment's checkout is `builder`. */
function branchOnly(origin: ReturnType<typeof remote>, builder: string | null, projectPath: string | null = origin.project) {
  const w = world({ projectPath, gitEnv: GIT_ENV });
  w.host.localPath.mockResolvedValue(builder);
  w.worker("W1", { branch: "feature/one" });
  return w;
}

describe("a target with no pull request is pinned at the tip of its branch on origin", () => {
  // Contract: no pull request head means `git ls-remote origin refs/heads/<branch>`, with the base from origin/HEAD.
  // Regression: the pin is a local ref, or the pull-request-less target cannot be gated.
  test("the pin is the origin tip, with origin/HEAD as the base", async () => {
    const origin = remote();
    const w = branchOnly(origin, origin.clone("builder", "feature/one"));
    await w.review.startReview(w.chief, "W1");

    expect(w.forge.head).not.toHaveBeenCalled();
    expect(w.store.gate("task:W1")!.targets).toEqual([{ threadId: "W1", reportSeq: 1, branch: "feature/one", prUrl: null, headSha: origin.tip("feature/one"), base: "main" }]);
    expect(w.launches.map((launch) => launch.row.role)).toEqual(["reviewer"]);
  });

  // Contract: no fallback to a mutable checkout: a branch missing from origin is refused even when the builder's checkout has it.
  // Regression: the pin falls back to the builder's or the project's local HEAD and the reviewer reads a commit nobody pushed.
  test("a branch that is not on origin is refused with the push recovery, whatever the builder's checkout holds", async () => {
    const origin = remote();
    const builder = origin.clone("builder", "feature/one");
    run(builder, "checkout", "-q", "-b", "feature/local-only");
    const w = world({ projectPath: origin.project, gitEnv: GIT_ENV });
    w.host.localPath.mockResolvedValue(builder);
    w.worker("W1", { branch: "feature/local-only" });

    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(/is not on origin.*chief_continue.*chief_forge_init/);
    expect(w.launches).toHaveLength(0);
    expect(w.store.gate("task:W1")).toBeUndefined();
  });

  test("with no local checkout of the project there is nothing to pin from and the gate does not open", async () => {
    const origin = remote();
    const w = branchOnly(origin, origin.clone("builder", "feature/one"), null);
    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(/no local checkout of the project/);
    expect(w.launches).toHaveLength(0);
  });
});

describe("the builder's checkout must be clean and contained in the pin", () => {
  const recovery = /chief_continue \(threadId: W1\) to commit and push.*chief_forge_init/;

  // Contract: uncommitted work is refused with the named recovery.
  // Regression: the gate pins a head that does not hold the builder's work, so the reviewer reads stale code.
  test.each([
    ["a modified file", (dir: string) => writeFileSync(join(dir, "f.txt"), "edited\n")],
    ["an untracked file", (dir: string) => writeFileSync(join(dir, "new.txt"), "new\n")],
  ])("%s is refused", async (_name, dirty) => {
    const origin = remote();
    const builder = origin.clone("builder", "feature/one");
    dirty(builder);
    const w = branchOnly(origin, builder);

    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(recovery);
    expect(w.launches).toHaveLength(0);
    expect(w.store.gate("task:W1")).toBeUndefined();
  });

  // Contract: a builder HEAD the pinned commit does not contain (a local commit never pushed) is refused.
  // Regression: unpushed work is silently left out of the review.
  test("a local commit that is not on origin is refused", async () => {
    const origin = remote();
    const builder = origin.clone("builder", "feature/one");
    writeFileSync(join(builder, "f.txt"), "unpushed\n");
    run(builder, "commit", "-aqm", "unpushed");
    const w = branchOnly(origin, builder);

    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(recovery);
    expect(w.launches).toHaveLength(0);
  });

  // Contract (plan-4 step 2): containment, not equality: a pin ahead of the builder's HEAD (the Spec Writer fold may be ahead) is accepted.
  // Regression: a builder one commit behind origin is refused although everything it has is in the pin.
  const aheadOf = (builder: string, origin: ReturnType<typeof remote>) => {
    const other = origin.clone("other", "feature/one");
    writeFileSync(join(other, "f.txt"), "ahead\n");
    run(other, "commit", "-aqm", "ahead");
    run(other, "push", "-q", "origin", "feature/one");
    return builder;
  };

  test("a builder behind the pinned commit that has fetched it is accepted", async () => {
    const origin = remote();
    const builder = aheadOf(origin.clone("builder", "feature/one"), origin);
    run(builder, "fetch", "-q", "origin");
    const w = branchOnly(origin, builder);

    await w.review.startReview(w.chief, "W1");
    expect(w.store.gate("task:W1")!.targets[0]!.headSha).toBe(origin.tip("feature/one"));
  });

  // The builder's clone has not fetched the pinned commit, which is how a Spec Writer's fold reaches origin.
  // PRODUCT DEFECT: the pin is ahead of the builder's HEAD, so `merge-base --is-ancestor HEAD <pin>` fails on an object the builder's clone does not have (src/review/reviewStart.ts:614).
  test("a builder behind the pinned commit that has not fetched it is accepted", async () => {
    const origin = remote();
    const builder = aheadOf(origin.clone("builder", "feature/one"), origin);
    const w = branchOnly(origin, builder);

    await w.review.startReview(w.chief, "W1");
    expect(w.store.gate("task:W1")!.targets[0]!.headSha).toBe(origin.tip("feature/one"));
  });

  // Contract: a builder whose checkout is not on the plugin server is refused with a handoff to a local worker.
  // Regression: a silent pass, or a refusal that no recovery can clear.
  test("a checkout the plugin server cannot reach is refused with recovery instructions", async () => {
    const origin = remote();
    const w = branchOnly(origin, null);
    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(/Worker W1.*not on the plugin server.*chief_delegate \(replaces: W1, kind: worker\)/);
  });

  // Contract: the check runs for every target, so one dirty builder in a plan refuses the whole gate.
  // Regression: only the calling worker's tree is checked.
  test("in a two-chain plan the other chain's dirty builder refuses the gate", async () => {
    const origin = remote(["feature/one", "feature/two"]);
    const dirty = origin.clone("builder-two", "feature/two");
    writeFileSync(join(dirty, "new.txt"), "new\n");
    const w = world({ realPlan: true, waves: TWO_CHAINS, projectPath: origin.project, gitEnv: GIT_ENV });
    w.host.localPath.mockImplementation(async (environmentId) => environmentId === "env_W1" ? origin.clone("builder-one", "feature/one") : dirty);
    w.worker("W1", { branch: "feature/one", planWave: 1 });
    w.worker("W2", { branch: "feature/two", planWave: 2 });

    await expect(w.review.startReview(w.chief, "W1")).rejects.toThrow(/Worker W2 has uncommitted changes.*chief_continue \(threadId: W2\)/);
    expect(w.launches).toHaveLength(0);
    expect(w.store.gate(KEY)).toBeUndefined();
  });
});
