import { gitWithin } from "../review/impactSlice";

// Node built-ins only and erasable types only, so `node` can import this file directly.
// Nothing here races a git call: every call is awaited until its child exits, so a returned function leaves no git running.

export type FastForward = { from: string; to: string } | { skipped: string };

/** The merge starts only with a full per-try git timeout left, so a deadline never kills it halfway through the working tree. */
export const MERGE_MIN_MS = 10_000;

const oneLine = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/\s+/g, " ").trim().slice(0, 200);

/** Moves the checkout at `cwd` to `origin/<branch>` with `git merge --ff-only`, or leaves it as it is. `deadline` is absolute (epoch ms). Never throws. */
export async function fastForward(opts: { cwd: string; env: NodeJS.ProcessEnv; branch: string; deadline: number }): Promise<FastForward> {
  const { branch, deadline } = opts;
  const git = gitWithin(opts.cwd, opts.env, deadline);
  const remote = `refs/remotes/origin/${branch}`;
  let step = "";
  try {
    // Local checks first. Untracked files do not count: one that would be overwritten fails the merge, which is reported.
    if ((await git(["status", "--porcelain", "--untracked-files=no"])).trim()) return { skipped: "it has uncommitted changes" };
    step = "git fetch failed";
    await git(["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${remote}`]);
    step = "";
    const from = (await git(["rev-parse", "HEAD"])).trim();
    const to = (await git(["rev-parse", remote])).trim();
    const ahead = Number((await git(["rev-list", "--count", `${remote}..HEAD`])).trim());
    if (ahead > 0) return { skipped: `its branch has ${ahead} commit(s) not on origin/${branch}` };
    if (from === to) return { from, to };
    if (deadline - Date.now() < MERGE_MIN_MS) return { skipped: "timed out before the merge" };
    step = "git merge --ff-only failed";
    // --no-overwrite-ignore: an ignored untracked file that origin adds is never replaced. A retry, too, needs the full reserve.
    await git(["merge", "--ff-only", "--no-overwrite-ignore", "--quiet", remote], false, MERGE_MIN_MS);
    return { from, to };
  } catch (error) {
    if ((error as Error)?.message === "deadline") return { skipped: "timed out" };
    return { skipped: step ? `${step}: ${oneLine(error)}` : oneLine(error) };
  }
}

/** Points the local `refs/heads/<branch>` at a freshly fetched `origin/<branch>`, because BB cuts a named-branch worktree from the local ref.
 * It creates a missing ref, and moves one that is behind or whose commits since the merge base leave the tree unchanged (the forge's empty `Start:` commit).
 * It leaves a ref whose tree differs, one a worktree has checked out, one that changed since it was validated, and any failure as `{ skipped }`.
 * The move is `git update-ref` with the validated SHA as its old value, after an explicit checked-out check: `git branch -f` has no old-value guard.
 * The fetch writes only the remote-tracking ref and FETCH_HEAD. Never throws, never touches HEAD, the index or the working tree of `cwd`, never pushes. `deadline` is absolute (epoch ms). */
export async function pointBranchAtOrigin(opts: { cwd: string; env: NodeJS.ProcessEnv; branch: string; deadline: number }): Promise<FastForward> {
  const { branch, deadline } = opts;
  const git = gitWithin(opts.cwd, opts.env, deadline);
  const remote = `refs/remotes/origin/${branch}`;
  const local = `refs/heads/${branch}`;
  // A non-zero exit is the answer false; only the deadline is an error.
  const ok = (args: string[]) => git(args).then(() => true, (error: Error) => { if (error.message === "deadline") throw error; return false; });
  let step = "";
  try {
    step = "git fetch failed";
    // --refmap= ignores configured fetch mappings, so no other local ref (e.g. +refs/heads/*:refs/heads/*) is written by this fetch.
    await git(["fetch", "--no-tags", "--no-prune", "--no-recurse-submodules", "--refmap=", "origin", `+refs/heads/${branch}:${remote}`]);
    step = "";
    const to = (await git(["rev-parse", remote])).trim();
    const from = (await git(["rev-parse", "--verify", "-q", local], true)).trim();
    if (!from) {
      step = "git branch failed";
      await git(["branch", branch, to]);
      return { from: to, to };
    }
    if (from === to) return { from, to };
    if (!(await ok(["merge-base", "--is-ancestor", from, to]))) {
      // Tree IDs, not `git diff`: diff.ignoreSubmodules and similar config can hide a changed file or gitlink.
      const base = (await git(["merge-base", from, to])).trim();
      if ((await git(["rev-parse", `${base}^{tree}`])).trim() !== (await git(["rev-parse", `${from}^{tree}`])).trim()) return { skipped: `local ${branch} has file changes not on origin/${branch}` };
    }
    step = "git worktree list failed";
    if ((await git(["worktree", "list", "--porcelain"])).split("\n").includes(`branch ${local}`)) return { skipped: `a worktree has ${branch} checked out` };
    step = `local ${branch} changed during the sync, or git update-ref failed`;
    await git(["update-ref", "-m", "chief: sync to origin", local, to, from]);
    return { from, to };
  } catch (error) {
    if ((error as Error)?.message === "deadline") return { skipped: "timed out" };
    return { skipped: step ? `${step}: ${oneLine(error)}` : oneLine(error) };
  }
}

/** The commit the checkout is at and, when readable, the commit `origin/<branch>` points to now. Never throws, never changes a ref. */
export async function commitStamp(opts: { cwd: string; env: NodeJS.ProcessEnv; branch: string; deadline: number }): Promise<{ read: string; head: string | null } | null> {
  const git = gitWithin(opts.cwd, opts.env, opts.deadline);
  let read: string;
  try {
    read = (await git(["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
  if (!read) return null;
  // Separately caught: once `read` exists it is always returned, whatever the comparison does.
  let head: string | null = null;
  try {
    head = (await git(["ls-remote", "origin", `refs/heads/${opts.branch}`])).trim().split(/\s+/)[0] || null;
  } catch { /* the comparison clause is dropped */ }
  return { read, head };
}

/** `Read at <12 hex>`, plus the moved-branch clause when the remote head is a different commit (inequality, not ancestry). */
export function stampLine(stamp: { read: string; head: string | null }, branch: string): string {
  const base = `Read at ${stamp.read.slice(0, 12)}`;
  return stamp.head && stamp.head !== stamp.read ? `${base}; ${branch} is now ${stamp.head.slice(0, 12)}, so this answer may be stale` : base;
}
