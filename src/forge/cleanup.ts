import { gitWithin } from "../review/impactSlice";

// Node built-ins only and erasable types only, so `node` can import this file directly.

/** The columns of a managed row that decide whether its task was positively approved and is now finished. */
export interface CleanupRow {
  thread_id: string;
  role: string;
  state: string;
  project_id: string;
  chief_thread_id: string | null;
  worker_thread_id: string | null;
  plan_thread_id: string | null;
  plan_wave: number | null;
  replaces_thread_id: string | null;
  plan_waves: string | null;
  cleanup_approved_at: number | null;
}

/** The ids of the complete rows whose whole task was approved: the stamped workers, the workers they replaced, and the
 * reviewers, advisors and planners that only existed for them. Every link must stay inside one Chief and one project;
 * anything that cannot be proved is left out. `targets` lists the worker ids a reviewer covered. */
export function cleanupEligible(rows: CleanupRow[], targets: (reviewerId: string) => string[]): Set<string> {
  const byId = new Map(rows.map((row) => [row.thread_id, row]));
  const memo = new Map<string, boolean>();
  const linked = (from: CleanupRow, id: string | null) => {
    const other = id ? byId.get(id) : undefined;
    return other && other.chief_thread_id === from.chief_thread_id && other.project_id === from.project_id ? other : undefined;
  };
  const qualifies = (id: string): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    memo.set(id, false); // a cycle reads false
    const row = byId.get(id);
    const result = !!row && row.state === "complete" && row.chief_thread_id !== null && decide(row);
    memo.set(id, result);
    return result;
  };
  const decide = (row: CleanupRow): boolean => {
    const same = (other: CleanupRow) => other.chief_thread_id === row.chief_thread_id && other.project_id === row.project_id;
    if (row.role === "worker") {
      return row.cleanup_approved_at !== null
        || rows.some((other) => other.role === "worker" && other.replaces_thread_id === row.thread_id && same(other) && qualifies(other.thread_id));
    }
    if (row.role === "reviewer") {
      const covered = targets(row.thread_id);
      return covered.length > 0 && covered.every((workerId) => { const target = linked(row, workerId); return !!target && qualifies(target.thread_id); });
    }
    if (row.role === "advisor") {
      const target = linked(row, row.plan_thread_id ?? row.worker_thread_id);
      return !!target && qualifies(target.thread_id);
    }
    if (row.role === "planner") {
      let waves = 0;
      try { waves = (JSON.parse(row.plan_waves ?? "[]") as unknown[]).length; } catch { waves = 0; }
      const workers = rows.filter((other) => other.role === "worker" && other.plan_thread_id === row.thread_id && same(other));
      const planned = waves > 0
        && Array.from({ length: waves }, (_, index) => index + 1).every((wave) => workers.some((worker) => worker.plan_wave === wave && qualifies(worker.thread_id)))
        && workers.every((worker) => qualifies(worker.thread_id));
      return planned || rows.some((other) => other.role === "planner" && other.replaces_thread_id === row.thread_id && same(other) && qualifies(other.thread_id));
    }
    return false; // chief, researcher
  };
  return new Set(rows.filter((row) => qualifies(row.thread_id)).map((row) => row.thread_id));
}

/** The branch name when it is a bb worktree branch (`bb/<slug>-thr_<id>`) of a thread `owns` accepts, else null. */
export function ownedBranch(branchName: string | null, owns: (threadId: string) => boolean): string | null {
  const suffix = branchName ? /^bb\/.+-(thr_[a-z0-9]+)$/.exec(branchName)?.[1] : undefined;
  return branchName && suffix && owns(suffix) ? branchName : null;
}

export type BranchDelete = { deleted: true; note?: string } | { gone: true } | { kept: string } | { error: string };

/** Deletes a local branch when no worktree has it checked out and either freshly fetched origin heads hold every commit on it,
 * or a merged task pull request's head (from `mergedHeads`, asked only when origin holds nothing) is the tip or contains it.
 * Local-only checks run before the network. Never throws. */
export async function deleteSafeBranch(opts: { cwd: string; env: NodeJS.ProcessEnv; branch: string; deadlineMs: number; mergedHeads?: () => Promise<string[]> }): Promise<BranchDelete> {
  const ref = `refs/heads/${opts.branch}`;
  try {
    let git = gitWithin(opts.cwd, opts.env, Date.now() + opts.deadlineMs);
    const tip = (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true)).trim();
    if (!tip) return { gone: true };
    const checkedOut = (await git(["for-each-ref", "--format=%(worktreepath)", ref])).trim();
    if (checkedOut) return { kept: `checked out at ${checkedOut}` };
    try { await git(["remote", "get-url", "origin"]); } catch { return { kept: "no origin remote to prove the commits are pushed" }; }
    // origin's heads only: after a pruning fetch refs/remotes/origin/* mirrors origin exactly; no other remote is proof.
    await git(["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
    const holders = (await git(["for-each-ref", "--contains", tip, "--format=%(refname)", "refs/remotes/origin/"])).split("\n").filter((name) => name && name !== "refs/remotes/origin/HEAD");
    if (!holders.length) {
      let proved = false;
      if (opts.mergedHeads) {
        const heads = await opts.mergedHeads();
        git = gitWithin(opts.cwd, opts.env, Date.now() + opts.deadlineMs); // the forge call must not use up the git deadline
        for (const head of heads) {
          if (!(await git(["rev-parse", "--verify", "--quiet", `${head}^{commit}`], true)).trim()) continue; // object not local: no proof
          // rev-list, not merge-base --is-ancestor: noMatchOk maps exit 1 to "" and would lose the answer.
          if ((await git(["rev-list", "--count", tip, "--not", head])).trim() === "0") { proved = true; break; }
        }
      }
      if (!proved) {
        const missing = (await git(["rev-list", "--count", tip, "--not", "--glob=refs/remotes/origin/*"])).trim();
        return { kept: `${missing} commit(s) not on origin${opts.mergedHeads ? " and no merged task pull request contains them" : ""}` };
      }
    }
    await git(["update-ref", "-d", ref, tip]); // compare-and-delete: refuses when the tip moved
    try { await git(["config", "--remove-section", `branch.${opts.branch}`]); }
    catch (error) {
      const message = String((error as Error)?.message ?? error).replace(/\s+/g, " ").trim();
      return /no such section/i.test(message) ? { deleted: true } : { deleted: true, note: `its branch.${opts.branch} config section was not removed: ${message.slice(0, 200)}` };
    }
    return { deleted: true };
  } catch (error) {
    return { error: String((error as Error)?.message ?? error).replace(/\s+/g, " ").trim().slice(0, 300) };
  }
}
