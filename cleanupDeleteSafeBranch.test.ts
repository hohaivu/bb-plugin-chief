import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deleteSafeBranch } from "./src/forge/cleanup";
import { gitEnv, gitFixture } from "./test/gitFixture";

// Contracts (wave 1, src/forge/cleanup.ts deleteSafeBranch), against real temporary git repositories (a bare origin and a clone):
// a bb/ branch is deleted when origin holds its tip, or when a merged task PR's head is the tip or contains it; in every other case it is kept.
const BRANCH = "bb/fix-totals-thr_abc123";
let fx: ReturnType<typeof gitFixture>;
beforeEach(() => { fx = gitFixture(); });
afterEach(() => fx.dispose());

const run = (mergedHeads?: () => Promise<string[]>) => deleteSafeBranch({ cwd: fx.clone, env: gitEnv, branch: BRANCH, deadlineMs: 30_000, mergedHeads });
/** The task branch with `count` commits on top of main, pushed, then its remote branch deleted (the squash-merge aftermath). Returns the tips, oldest first. */
function squashMerged(count = 1) {
  fx.git("checkout", "-q", "-b", BRANCH, "main");
  fx.git("config", `branch.${BRANCH}.remote`, "origin");
  fx.git("config", `branch.${BRANCH}.merge`, `refs/heads/${BRANCH}`);
  const tips = Array.from({ length: count }, (_, index) => fx.commit(`work ${index + 1}`));
  fx.pushThenDeleteRemote(BRANCH);
  fx.git("checkout", "-q", "main");
  return tips;
}
const noProofSuffix = " and no merged task pull request contains them";

describe("deleteSafeBranch: origin holds the tip", () => {
  test("is deleted and never asks the forge", async () => {
    fx.git("checkout", "-q", "-b", BRANCH, "main");
    fx.commit("work");
    fx.git("push", "-q", "origin", BRANCH);
    fx.git("checkout", "-q", "main");
    const mergedHeads = vi.fn(async () => [] as string[]);
    expect(await run(mergedHeads)).toEqual({ deleted: true });
    expect(fx.hasBranch(BRANCH)).toBe(false);
    expect(mergedHeads).not.toHaveBeenCalled();
  });
});

describe("deleteSafeBranch: the remote branch is gone", () => {
  test("a merged PR whose head is the tip: deleted, the ref and its branch config section are removed", async () => {
    const [tip] = squashMerged();
    expect(fx.git("config", "--get-regexp", `^branch\\.${BRANCH}\\.`)).not.toBe("");
    expect(await run(async () => [tip!])).toEqual({ deleted: true });
    expect(fx.hasBranch(BRANCH)).toBe(false);
    expect(() => fx.git("config", "--get-regexp", `^branch\\.${BRANCH}\\.`)).toThrow(); // exit 1: no key left
  });

  test("a merged PR whose head is a descendant of the tip (the empty forge 'Start:' commit case): deleted", async () => {
    const [tip] = squashMerged();
    fx.git("checkout", "-q", "-b", "pr-head", tip!);
    fx.commit("task commit");
    const head = fx.commit("another task commit");
    fx.git("checkout", "-q", "main");
    expect(await run(async () => [head])).toEqual({ deleted: true });
    expect(fx.hasBranch(BRANCH)).toBe(false);
  });

  test("a head that does not contain the tip is skipped, a later head that does is still honoured", async () => {
    const [tip] = squashMerged();
    fx.git("checkout", "-q", "-b", "other-pr", "main");
    const unrelated = fx.commit("unrelated");
    fx.git("checkout", "-q", "main");
    expect(await run(async () => [unrelated, tip!])).toEqual({ deleted: true });
    expect(fx.hasBranch(BRANCH)).toBe(false);
  });

  test("the tip has a commit after the PR head: kept, nothing deleted", async () => {
    const [first, second] = squashMerged(2);
    expect(await run(async () => [first!])).toEqual({ kept: `2 commit(s) not on origin${noProofSuffix}` });
    expect(fx.sha(BRANCH)).toBe(second);
  });

  test("a PR head that holds the same change as a cherry-pick (different commit): kept", async () => {
    const [tip] = squashMerged();
    fx.git("checkout", "-q", "-b", "pr-head", "main");
    fx.commit("moved on"); // a different parent, so the cherry-pick is a different commit
    fx.git("cherry-pick", tip!);
    const head = fx.sha("HEAD");
    fx.git("checkout", "-q", "main");
    expect(head).not.toBe(tip);
    expect(await run(async () => [head])).toEqual({ kept: `1 commit(s) not on origin${noProofSuffix}` });
    expect(fx.sha(BRANCH)).toBe(tip);
  });

  test("a PR head whose object is not in this repository: kept, no throw", async () => {
    const [tip] = squashMerged();
    const other = gitFixture();
    try {
      const missing = other.commit("only in another repository");
      expect(await run(async () => [missing])).toEqual({ kept: `1 commit(s) not on origin${noProofSuffix}` });
    } finally {
      other.dispose();
    }
    expect(fx.sha(BRANCH)).toBe(tip);
  });

  test("a head that is missing locally is skipped, a later head that proves the tip is honoured", async () => {
    const [tip] = squashMerged();
    const other = gitFixture();
    try {
      expect(await run(async () => [other.commit("only in another repository"), tip!])).toEqual({ deleted: true });
    } finally {
      other.dispose();
    }
  });

  test.each([
    ["no merged PR head", async () => [] as string[], noProofSuffix],
    ["no forge lookup given", undefined, ""],
  ])("%s: kept with the not-on-origin count", async (_name, mergedHeads, suffix) => {
    const tips = squashMerged(3);
    expect(await run(mergedHeads)).toEqual({ kept: `3 commit(s) not on origin${suffix}` });
    expect(fx.sha(BRANCH)).toBe(tips[2]);
  });

  test("a forge lookup that throws returns an error and leaves the branch alone", async () => {
    const [tip] = squashMerged();
    expect(await run(async () => { throw new Error("forge timed out"); })).toEqual({ error: "forge timed out" });
    expect(fx.sha(BRANCH)).toBe(tip);
  });

  test("a second run on the deleted branch reports it gone", async () => {
    const [tip] = squashMerged();
    expect(await run(async () => [tip!])).toEqual({ deleted: true });
    expect(await run(async () => [tip!])).toEqual({ gone: true });
  });
});

describe("deleteSafeBranch: local checks come before any forge call", () => {
  test("a checked-out branch is kept", async () => {
    const [tip] = squashMerged();
    fx.git("worktree", "add", "-q", `${fx.root}/linked`, BRANCH);
    const mergedHeads = vi.fn(async () => [tip!]);
    const result = await run(mergedHeads);
    expect(result).toEqual({ kept: `checked out at ${fx.root}/linked` });
    expect(mergedHeads).not.toHaveBeenCalled();
    expect(fx.hasBranch(BRANCH)).toBe(true);
  });

  test("a repository without an origin remote keeps the branch", async () => {
    const [tip] = squashMerged();
    fx.git("remote", "remove", "origin");
    const mergedHeads = vi.fn(async () => [tip!]);
    expect(await run(mergedHeads)).toEqual({ kept: "no origin remote to prove the commits are pushed" });
    expect(mergedHeads).not.toHaveBeenCalled();
    expect(fx.hasBranch(BRANCH)).toBe(true);
  });
});
