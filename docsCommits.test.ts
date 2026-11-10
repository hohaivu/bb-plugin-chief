import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsCommits } from "./src/review/impactSlice";

// Contract C6 (plan wave 1, "Only the Spec Writer edits docs/ everywhere"): `docsCommits` reads the task's pushed head from ORIGIN,
// returns the non-merge commits that change docs/ with the Chief-Spec-Writer trailer each carries, and never throws.
// Real git on temp repositories with a bare origin: the contract is what git reports, so nothing is mocked.
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
let root: string;
let counter = 0;

/** A bare origin with `main` (one non-docs commit), a `work` clone with origin/HEAD set, and a `peer` clone that can push behind work's back. */
function repos() {
  const dir = join(root, `r${(counter += 1)}`);
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "remote", "add", "origin", origin);
  const commit = (cwd: string, file: string, message: string, trailer?: string) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), `${message}\n${counter}\n${Math.random()}`);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message, ...(trailer ? ["--trailer", `Chief-Spec-Writer: ${trailer}`] : []));
    return git(cwd, "rev-parse", "HEAD");
  };
  commit(work, "src/a.ts", "base");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  const peer = join(dir, "peer");
  git(dir, "clone", "-q", origin, peer);
  return { dir, origin, work, peer, commit };
}
const read = (cwd: string, head: { branch: string; sha?: string; base?: string }, deadlineMs = 20_000) => docsCommits({ cwd, env, deadlineMs, head });
const ok = (found: Awaited<ReturnType<typeof read>>) => {
  if ("skipped" in found) throw new Error(`expected commits, got skipped: ${found.skipped}`);
  return found;
};

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "docs-commits-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("docsCommits", () => {
  test("lists each non-merge docs/ commit of the pushed branch with its trailer, and none for a non-docs commit", async () => {
    const { work, commit } = repos();
    git(work, "checkout", "-q", "-b", "task");
    const tagged = commit(work, "docs/specs/a.md", "docs: tagged", "thr_writer");
    const bare = commit(work, "docs/specs/b.md", "docs: bare");
    commit(work, "src/b.ts", "code only");
    git(work, "push", "-q", "origin", "task");
    const found = ok(await read(work, { branch: "task" }));
    expect(found.base).toBe("origin/main");
    expect(found.commits.map((entry) => [entry.sha, entry.writer, entry.paths])).toEqual([
      [bare, "", ["docs/specs/b.md"]],
      [tagged, "thr_writer", ["docs/specs/a.md"]],
    ]);
    expect(found.commits.map((entry) => entry.subject)).toEqual(["docs: bare", "docs: tagged"]);
  });

  test("a merge commit is never listed; the docs/ commits it brought in still are", async () => {
    const { work, commit } = repos();
    git(work, "checkout", "-q", "-b", "side");
    const inner = commit(work, "docs/specs/side.md", "docs: on the side", "thr_writer");
    git(work, "checkout", "-q", "-b", "task", "main");
    commit(work, "src/c.ts", "code");
    git(work, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const merge = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "origin", "task");
    const found = ok(await read(work, { branch: "task" }));
    expect(found.commits.map((entry) => entry.sha)).toEqual([inner]);
    expect(found.commits.map((entry) => entry.sha)).not.toContain(merge);
  });

  test("a stale local refs/heads/task never counts: the offending commit exists only on origin", async () => {
    const { work, peer, commit } = repos();
    git(work, "checkout", "-q", "-b", "task");
    commit(work, "src/clean.ts", "clean");
    git(work, "push", "-q", "origin", "task");
    git(peer, "fetch", "-q", "origin");
    git(peer, "checkout", "-q", "task");
    const offending = commit(peer, "docs/specs/late.md", "docs: pushed later");
    git(peer, "push", "-q", "origin", "task");
    // work's own `task` still points at the clean commit and its origin/task is stale until the fetch inside docsCommits.
    expect(git(work, "rev-parse", "task")).not.toBe(offending);
    const found = ok(await read(work, { branch: "task" }));
    expect(found.head).toBe(offending);
    expect(found.commits.map((entry) => entry.sha)).toEqual([offending]);
  });

  test("a pull request head sha is read against its own base: the parent branch's docs/ commits are excluded", async () => {
    const { work, commit } = repos();
    git(work, "checkout", "-q", "-b", "parent");
    commit(work, "docs/specs/parent.md", "docs: parent owns this");
    git(work, "push", "-q", "origin", "parent");
    git(work, "checkout", "-q", "-b", "task");
    const own = commit(work, "docs/specs/own.md", "docs: task owns this", "thr_writer");
    git(work, "push", "-q", "origin", "task");
    const sha = git(work, "rev-parse", "HEAD");
    expect(ok(await read(work, { branch: "task", sha, base: "parent" })).commits.map((entry) => entry.sha)).toEqual([own]);
    // Against the default branch the parent's commit would be in range: the base is what scopes it.
    expect(ok(await read(work, { branch: "task", sha })).commits).toHaveLength(2);
  });

  test("a pull request head sha newer than origin/<branch> is the head that is read", async () => {
    const { work, commit } = repos();
    git(work, "checkout", "-q", "-b", "task");
    const first = commit(work, "docs/specs/one.md", "docs: one", "thr_writer");
    git(work, "push", "-q", "origin", "task");
    const sha = git(work, "rev-parse", "HEAD");
    commit(work, "docs/specs/two.md", "docs: two, pushed after the PR head was read");
    git(work, "push", "-q", "origin", "task");
    expect(ok(await read(work, { branch: "task", sha })).commits.map((entry) => entry.sha)).toEqual([first]);
  });

  describe("never throws: every failure is a skip reason", () => {
    test("the branch cannot be fetched", async () => {
      const { work } = repos();
      expect(await read(work, { branch: "no-such-branch" })).toEqual({ skipped: "could not fetch origin/no-such-branch" });
    });
    test("the base cannot be fetched", async () => {
      const { work, commit } = repos();
      git(work, "checkout", "-q", "-b", "task");
      commit(work, "src/x.ts", "x");
      git(work, "push", "-q", "origin", "task");
      expect(await read(work, { branch: "task", sha: git(work, "rev-parse", "HEAD"), base: "no-such-base" })).toEqual({ skipped: "could not fetch origin/no-such-base" });
    });
    test("the pull request head sha is unknown", async () => {
      const { work, commit } = repos();
      git(work, "checkout", "-q", "-b", "task");
      commit(work, "src/x.ts", "x");
      git(work, "push", "-q", "origin", "task");
      const found = await read(work, { branch: "task", sha: "b".repeat(40) });
      expect(found).toEqual({ skipped: `pull request head ${"b".repeat(12)} not found after fetching origin/task` });
    });
    test("origin/HEAD is not set and no base is given", async () => {
      const { work, commit } = repos();
      git(work, "checkout", "-q", "-b", "task");
      commit(work, "docs/specs/x.md", "docs: x");
      git(work, "push", "-q", "origin", "task");
      git(work, "remote", "set-head", "origin", "-d");
      expect(await read(work, { branch: "task" })).toEqual({ skipped: "origin/HEAD not set" });
    });
    test("the checkout has no origin at all", async () => {
      const dir = mkdtempSync(join(root, "bare-"));
      git(dir, "init", "-q");
      const found = await read(dir, { branch: "task" });
      expect(found).toEqual({ skipped: "could not fetch origin/task" });
    });
    test("the directory is not a repository", async () => {
      const found = await read(mkdtempSync(join(root, "plain-")), { branch: "task" });
      expect("skipped" in found).toBe(true);
    });
    test("the deadline passes before git finishes", async () => {
      const { work, commit } = repos();
      git(work, "checkout", "-q", "-b", "task");
      commit(work, "docs/specs/x.md", "docs: x");
      git(work, "push", "-q", "origin", "task");
      const found = await read(work, { branch: "task" }, 1);
      expect("skipped" in found).toBe(true);
    });
  });
});
