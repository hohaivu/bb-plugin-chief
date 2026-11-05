import { gitWithin } from "./impactSlice";

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
