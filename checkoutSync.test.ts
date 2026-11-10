import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MERGE_MIN_MS, commitStamp, fastForward, stampLine } from "./src/forge/checkoutSync";

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
    expect(stampLine({ read: "a".repeat(40), head: "b".repeat(40) }, "main")).toBe(`Read at ${"a".repeat(12)}; main is now ${"b".repeat(12)}, so this answer may be stale`);
  });

  test("an unknown head adds nothing", () => {
    expect(stampLine({ read: "a".repeat(40), head: null }, "main")).toBe(`Read at ${"a".repeat(12)}`);
  });
});
