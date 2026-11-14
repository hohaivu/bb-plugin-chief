import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real bare origin plus a clone of it in a temporary directory, for tests that need true git ancestry semantics.
// Import node:child_process for real here: test files that mock it must spread the actual module (see cleanupMergedBranch.test.ts).
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
export const gitEnv = GIT_ENV;

export function gitFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chief-branch-")));
  const origin = join(root, "origin.git");
  const clone = join(root, "work");
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run(root, "init", "--bare", "-b", "main", origin);
  run(root, "clone", "-q", origin, clone);
  let counter = 0;
  const git = (...args: string[]) => run(clone, ...args);
  /** A commit on the checked-out branch that changes a unique file; returns its sha. */
  const commit = (message: string) => {
    counter += 1;
    writeFileSync(join(clone, `file-${counter}.txt`), `${message}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("checkout", "-q", "-b", "main");
  commit("base");
  git("push", "-q", "-u", "origin", "main");
  return {
    root, origin, clone, git, commit, run,
    sha: (rev: string) => git("rev-parse", rev),
    /** Whether a local branch still exists. */
    hasBranch: (branch: string) => { try { git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`); return true; } catch { return false; } },
    /** Mimics a squash merge: the branch was pushed, then its remote branch was deleted. Local commits stay unreachable from origin. */
    pushThenDeleteRemote: (branch: string) => { git("push", "-q", "origin", branch); git("push", "-q", "origin", "--delete", branch); },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
