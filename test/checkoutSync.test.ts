import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MERGE_MIN_MS, commitStamp, fastForward, pointBranchAtOrigin, stampLine } from "../src/forge/checkoutSync";

// Real git against local bare remotes in temp dirs: no network, no mocks.
const ENV = process.env;
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A bare origin with c0 on main, `chief` (the checkout under test, at c0) and `other` (a second clone that pushes). */
function repos() {
  const root = mkdtempSync(join(tmpdir(), "chief-ff-"));
  const origin = join(root, "origin.git");
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  const other = join(root, "other");
  sh(root, "clone", "-q", origin, other);
  writeFileSync(join(other, "a.txt"), "c0\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-q", "-m", "c0");
  sh(other, "push", "-q", "origin", "HEAD:main");
  const chief = join(root, "chief");
  sh(root, "clone", "-q", "-b", "main", origin, chief);
  const c0 = sh(chief, "rev-parse", "HEAD");
  /** Pushes a new commit to origin/main from `other`; returns its SHA. */
  const push = (file = "a.txt", content = `c${Math.random()}\n`) => {
    writeFileSync(join(other, file), content);
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", `change ${file}`);
    sh(other, "push", "-q", "origin", "HEAD:main");
    return sh(other, "rev-parse", "HEAD");
  };
  const opts = (extra: { deadline?: number; cwd?: string } = {}) => ({ cwd: chief, env: ENV, branch: "main", deadline: Date.now() + 30_000, ...extra });
  const head = () => sh(chief, "rev-parse", "HEAD");
  return { root, origin, other, chief, c0, push, opts, head };
}

describe("fastForward", () => {
  test("moves a behind, clean clone to origin/main and only forward: ancestor, no merge commit, other branches and stash untouched", async () => {
    const r = repos();
    sh(r.chief, "branch", "side", r.c0);
    const tip = r.push();
    expect(await fastForward(r.opts())).toEqual({ from: r.c0, to: tip });
    expect(r.head()).toBe(tip);
    expect(() => sh(r.chief, "merge-base", "--is-ancestor", r.c0, tip)).not.toThrow();
    expect(sh(r.chief, "rev-list", "--merges", "HEAD")).toBe("");
    expect(sh(r.chief, "rev-parse", "side")).toBe(r.c0);
    expect(sh(r.chief, "stash", "list")).toBe("");
    expect(sh(r.chief, "branch", "--list", "--format=%(refname:short)").split("\n").sort()).toEqual(["main", "side"]);
  });

  test("is idempotent: a second call returns {from: X, to: X} and leaves HEAD unchanged", async () => {
    const r = repos();
    const tip = r.push();
    await fastForward(r.opts());
    expect(await fastForward(r.opts())).toEqual({ from: tip, to: tip });
    expect(r.head()).toBe(tip);
  });

  test("a clone that is already current is {from, to} with equal values", async () => {
    const r = repos();
    expect(await fastForward(r.opts())).toEqual({ from: r.c0, to: r.c0 });
  });

  test.each([
    ["a tracked modified file", (dir: string) => writeFileSync(join(dir, "a.txt"), "dirty\n")],
    ["a staged file", (dir: string) => { writeFileSync(join(dir, "a.txt"), "staged\n"); sh(dir, "add", "a.txt"); }],
  ])("skips for %s and leaves HEAD where it was", async (_name, dirty) => {
    const r = repos();
    r.push("other.txt", "x\n");
    dirty(r.chief);
    expect(await fastForward(r.opts())).toEqual({ skipped: expect.stringMatching(/uncommitted/) });
    expect(r.head()).toBe(r.c0);
  });

  test("an untracked file that does not collide does not block the fast-forward", async () => {
    const r = repos();
    const tip = r.push("other.txt", "x\n");
    writeFileSync(join(r.chief, "scratch.txt"), "mine\n");
    expect(await fastForward(r.opts())).toEqual({ from: r.c0, to: tip });
    expect(r.head()).toBe(tip);
  });

  test("skips when HEAD has a commit origin/main does not, even when origin also moved", async () => {
    const r = repos();
    writeFileSync(join(r.chief, "local.txt"), "local\n");
    sh(r.chief, "add", "-A");
    sh(r.chief, "commit", "-q", "-m", "local");
    const local = r.head();
    expect(await fastForward(r.opts())).toEqual({ skipped: expect.stringMatching(/its branch has 1 commit\(s\) not on origin\/main/) });
    r.push();
    expect(await fastForward(r.opts())).toEqual({ skipped: expect.stringMatching(/1 commit\(s\) not on origin\/main/) });
    expect(r.head()).toBe(local);
  });

  test("a bad origin is a fetch-failed skip, never a throw", async () => {
    const r = repos();
    sh(r.chief, "remote", "set-url", "origin", join(r.root, "does-not-exist.git"));
    expect(await fastForward(r.opts())).toEqual({ skipped: expect.stringMatching(/^git fetch failed: /) });
    expect(r.head()).toBe(r.c0);
  });

  test("an untracked file the fast-forward would overwrite fails the merge and is reported", async () => {
    const r = repos();
    r.push("new.txt", "from origin\n");
    writeFileSync(join(r.chief, "new.txt"), "mine\n");
    expect(await fastForward(r.opts())).toEqual({ skipped: expect.stringMatching(/^git merge --ff-only failed: /) });
    expect(r.head()).toBe(r.c0);
  });

  test("an ignored untracked file that origin adds is never overwritten: merge-failed skip, file bytes and HEAD unchanged", async () => {
    const r = repos();
    appendFileSync(join(r.chief, ".git", "info", "exclude"), "local.env\n");
    writeFileSync(join(r.chief, "local.env"), "SECRET=mine\n");
    r.push("local.env", "from origin\n");
    expect(sh(r.chief, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(await fastForward(r.opts())).toEqual({ skipped: expect.stringMatching(/^git merge --ff-only failed: /) });
    expect(readFileSync(join(r.chief, "local.env"), "utf8")).toBe("SECRET=mine\n");
    expect(r.head()).toBe(r.c0);
  });

  test("a deadline already past is a timed-out skip that changes no ref", async () => {
    const r = repos();
    r.push();
    const refs = () => sh(r.chief, "for-each-ref");
    const before = refs();
    expect(await fastForward(r.opts({ deadline: Date.now() - 1 }))).toEqual({ skipped: "timed out" });
    expect(refs()).toBe(before);
  });

  test("with less than MERGE_MIN_MS left after the fetch, it skips before the merge and HEAD stays", async () => {
    const r = repos();
    r.push();
    expect(MERGE_MIN_MS).toBe(10_000);
    expect(await fastForward(r.opts({ deadline: Date.now() + MERGE_MIN_MS - 1_000 }))).toEqual({ skipped: expect.stringMatching(/before the merge/) });
    expect(r.head()).toBe(r.c0);
  });
});

describe("commitStamp", () => {
  test("reads HEAD, and origin's current main from ls-remote, without changing any ref", async () => {
    const r = repos();
    const tip = r.push();
    const refs = sh(r.chief, "for-each-ref");
    expect(await commitStamp(r.opts())).toEqual({ read: r.c0, head: tip });
    expect(sh(r.chief, "for-each-ref")).toBe(refs);
  });

  test("a broken remote keeps the local SHA and drops only the comparison", async () => {
    const r = repos();
    sh(r.chief, "remote", "set-url", "origin", join(r.root, "does-not-exist.git"));
    expect(await commitStamp(r.opts())).toEqual({ read: r.c0, head: null });
  });

  test("an unreadable checkout is null", async () => {
    const r = repos();
    expect(await commitStamp(r.opts({ cwd: join(r.root, "missing") }))).toBeNull();
  });
});

describe("stampLine", () => {
  test("equal SHAs give only the Read at line, 12 hex", () => {
    const sha = "0123456789abcdef".repeat(2).slice(0, 40);
    expect(stampLine({ read: sha, head: sha }, "main")).toBe("Read at 0123456789ab");
  });

  test("a different head adds the stale clause", () => {
    const line = stampLine({ read: "a".repeat(40), head: "b".repeat(40) }, "main");
    expect(line.startsWith(`Read at ${"a".repeat(12)}`)).toBe(true);
    expect(line).toContain("b".repeat(12));
    expect(line).toContain("main");
  });

  test("an unknown head adds nothing", () => {
    expect(stampLine({ read: "a".repeat(40), head: null }, "main")).toBe(`Read at ${"a".repeat(12)}`);
  });
});

describe("pointBranchAtOrigin", () => {
  /** origin/feat is rewritten from c0 to a tip `tip` (one file change); the project checkout `chief` has no local feat yet. */
  function world() {
    const r = repos();
    sh(r.other, "checkout", "-q", "-b", "feat", r.c0);
    writeFileSync(join(r.other, "b.txt"), "tip\n");
    sh(r.other, "add", "-A");
    sh(r.other, "commit", "-q", "-m", "tip");
    sh(r.other, "push", "-q", "origin", "HEAD:feat");
    const tip = sh(r.other, "rev-parse", "HEAD");
    const call = async (branch = "feat", env: NodeJS.ProcessEnv = ENV) => {
      const before = { head: r.head(), status: sh(r.chief, "status", "--porcelain") };
      const result = await pointBranchAtOrigin({ ...r.opts({ branch } as never), env });
      expect({ head: r.head(), status: sh(r.chief, "status", "--porcelain") }).toEqual(before);
      return result;
    };
    const local = (branch = "feat") => sh(r.chief, "rev-parse", `refs/heads/${branch}`);
    /** A local feat one commit past c0; `file` makes the commit change a file, else it is empty like the forge's Start commit. */
    const localCommit = (file?: string) => {
      sh(r.chief, "checkout", "-q", "-b", "feat", r.c0);
      if (file) writeFileSync(join(r.chief, file), "local\n");
      sh(r.chief, "add", "-A");
      sh(r.chief, "commit", "-q", "--allow-empty", "-m", "Start");
      sh(r.chief, "checkout", "-q", "main");
    };
    return { ...r, tip, call, local, localCommit };
  }

  test("moves a local ref that only has an empty Start commit (the observed bug) to the origin tip", async () => {
    const w = world();
    w.localCommit();
    expect(w.local()).not.toBe(w.tip);
    expect(await w.call()).toEqual({ from: expect.any(String), to: w.tip });
    expect(w.local()).toBe(w.tip);
  });

  test("moves a local ref that is only behind", async () => {
    const w = world();
    sh(w.chief, "branch", "feat", w.c0);
    expect(await w.call()).toEqual({ from: w.c0, to: w.tip });
    expect(w.local()).toBe(w.tip);
  });

  test("creates a missing local ref at the origin tip", async () => {
    const w = world();
    expect(await w.call()).toEqual({ from: w.tip, to: w.tip });
    expect(w.local()).toBe(w.tip);
  });

  test("is idempotent: a second call returns {from: T, to: T} and changes no ref", async () => {
    const w = world();
    await w.call();
    expect(await w.call()).toEqual({ from: w.tip, to: w.tip });
    expect(w.local()).toBe(w.tip);
  });

  test("leaves a local ref that carries a file change not on origin", async () => {
    const w = world();
    w.localCommit("mine.txt");
    const mine = w.local();
    expect(await w.call()).toHaveProperty("skipped");
    expect(w.local()).toBe(mine);
  });

  test("does not move a branch that a worktree has checked out", async () => {
    const w = world();
    w.localCommit();
    const start = w.local();
    sh(w.chief, "worktree", "add", join(w.root, "wt"), "feat");
    expect(await w.call()).toHaveProperty("skipped");
    expect(w.local()).toBe(start);
  });

  test("does not move a branch that a worktree is rebasing (its HEAD is detached)", async () => {
    const w = world();
    w.localCommit();
    const start = w.local();
    const wt = join(w.root, "wt");
    sh(w.chief, "worktree", "add", wt, "feat");
    // Stops after replaying the empty Start commit: HEAD is detached and the rebase state is on disk.
    expect(() => sh(wt, "rebase", "--no-ff", "--empty=keep", "--exec", "false", w.c0)).toThrow();
    expect(sh(wt, "branch", "--show-current")).toBe("");
    expect(await w.call()).toHaveProperty("skipped");
    expect(w.local()).toBe(start);
  });

  test("never moves a branch through a symbolic ref: the ref it points at stays put", async () => {
    const w = world();
    sh(w.chief, "symbolic-ref", "refs/heads/feat", "refs/heads/main");
    expect(await w.call()).toHaveProperty("skipped");
    expect(sh(w.chief, "symbolic-ref", "refs/heads/feat")).toBe("refs/heads/main");
    expect(sh(w.chief, "rev-parse", "refs/heads/main")).toBe(w.c0);
  });

  test("leaves the local ref and skips when origin has no such branch", async () => {
    const w = world();
    sh(w.chief, "branch", "nope", w.c0);
    expect(await w.call("nope")).toHaveProperty("skipped");
    expect(w.local("nope")).toBe(w.c0);
  });

  test("a configured fetch mapping onto the local head never overwrites an unpushed branch", async () => {
    const w = world();
    w.localCommit("mine.txt");
    const mine = w.local();
    sh(w.chief, "config", "--add", "remote.origin.fetch", "+refs/heads/feat:refs/heads/feat");
    expect(await w.call()).toHaveProperty("skipped");
    expect(w.local()).toBe(mine);
  });

  test("a local commit whose only change is a submodule pointer is not discarded, even with diff.ignoreSubmodules=all", async () => {
    const w = world();
    sh(w.chief, "config", "diff.ignoreSubmodules", "all");
    sh(w.chief, "checkout", "-q", "-b", "feat", w.c0);
    sh(w.chief, "update-index", "--add", "--cacheinfo", `160000,${w.c0},sub`);
    sh(w.chief, "commit", "-q", "-m", "bump sub");
    sh(w.chief, "checkout", "-q", "main");
    const mine = w.local();
    expect(await w.call()).toHaveProperty("skipped");
    expect(w.local()).toBe(mine);
  });

  /** A git wrapper on PATH: `before` (shell, with $REAL_GIT set) runs just before the real `update-ref`, so another writer changes the ref between validation and the write. */
  function beforeWrite(w: ReturnType<typeof world>, before: string) {
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = mkdtempSync(join(w.root, "bin-"));
    writeFileSync(join(bin, "git"), `#!/bin/sh\nREAL_GIT=${realGit}\nif [ "$1" = update-ref ]; then ${before}; fi\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    return { ...ENV, PATH: `${bin}:${ENV.PATH}` };
  }

  test("a SHA written to the ref immediately before the write is kept and nothing else moves", async () => {
    const w = world();
    w.localCommit();
    const start = w.local();
    const unpushed = sh(w.chief, "commit-tree", "-p", start, "-m", "unpushed", `${start}^{tree}`);
    const env = beforeWrite(w, `$REAL_GIT update-ref refs/heads/feat ${unpushed}`);
    expect(await w.call("feat", env)).toHaveProperty("skipped");
    expect(w.local()).toBe(unpushed);
    expect(w.local("main")).toBe(w.c0);
  });

  test("a ref turned symbolic immediately before the write leaves the target branch where it was", async () => {
    const w = world();
    w.localCommit();
    const env = beforeWrite(w, "$REAL_GIT symbolic-ref refs/heads/feat refs/heads/main");
    expect(await w.call("feat", env)).toHaveProperty("skipped");
    expect(sh(w.chief, "symbolic-ref", "refs/heads/feat")).toBe("refs/heads/main");
    expect(w.local("main")).toBe(w.c0);
  });

  test("a free branch moves while another worktree has a different branch checked out", async () => {
    const w = world();
    w.localCommit();
    sh(w.chief, "worktree", "add", "-b", "elsewhere", join(w.root, "wt"), w.c0);
    expect(await w.call()).toEqual({ from: expect.any(String), to: w.tip });
    expect(w.local()).toBe(w.tip);
  });

  test("submodule.recurse and submodule.propagateBranches do not move the submodule's branch", async () => {
    const w = world();
    // A submodule whose branch feat sits at s1, while origin/feat's gitlink points at s2.
    const src = join(w.root, "subsrc");
    sh(w.root, "init", "-q", "-b", "main", src);
    sh(src, "commit", "-q", "--allow-empty", "-m", "s1");
    const s1 = sh(src, "rev-parse", "HEAD");
    sh(src, "commit", "-q", "--allow-empty", "-m", "s2");
    const s2 = sh(src, "rev-parse", "HEAD");
    sh(w.chief, "-c", "protocol.file.allow=always", "submodule", "add", "-q", src, "sub");
    sh(w.chief, "commit", "-q", "-m", "add sub");
    sh(join(w.chief, "sub"), "branch", "feat", s1);
    sh(w.other, "checkout", "-q", "feat");
    sh(w.other, "update-index", "--add", "--cacheinfo", `160000,${s2},sub`);
    sh(w.other, "commit", "-q", "-m", "bump sub");
    sh(w.other, "push", "-q", "origin", "HEAD:feat");
    const tip = sh(w.other, "rev-parse", "HEAD");
    sh(w.chief, "branch", "feat", w.c0);
    sh(w.chief, "config", "submodule.recurse", "true");
    sh(w.chief, "config", "submodule.propagateBranches", "true");
    expect(await w.call()).toEqual({ from: w.c0, to: tip });
    expect(w.local()).toBe(tip);
    expect(sh(join(w.chief, "sub"), "rev-parse", "refs/heads/feat")).toBe(s1);
  });
});
