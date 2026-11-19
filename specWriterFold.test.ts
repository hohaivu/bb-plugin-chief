import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Wave 1 contract (hook-safe spec fold, plan thr_ku48rd8eyv wave 2, section B7): the Spec Writer's fold runs the command sequence of
// skills/chief-role-spec-writer/SKILL.md section 10 on its own checkout: B starts as the writer's Base commit; each attempt notes U (origin/<branch>)
// and H (HEAD), runs `git rebase --no-autostash --onto origin/<branch> $B`, checks that only docs/ changed, pushes without --force, and after a rejected
// push sets B=U and tries again; on a conflict it runs `git rebase --quit` and stops. The sequence is scripted here against real temporary repositories
// with a bare origin; what is asserted is what git published, never the checkout the writer is left with.
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_EDITOR: "true" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
/** The exit status and output of a git command that may fail. */
const attempt = (cwd: string, ...args: string[]) => { const run = spawnSync("git", args, { cwd, env, encoding: "utf8" }); return { status: run.status, output: `${run.stdout}${run.stderr}`.trim() }; };
const BRANCH = "feature/task";
let root: string;
let counter = 0;

/** A bare origin holding `main` and the task branch, plus helpers to clone it and to commit with or without the Spec Writer trailer. */
function world() {
  const dir = join(root, `w${(counter += 1)}`);
  mkdirSync(dir);
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const clone = (name: string, ref: string = BRANCH) => {
    const target = join(dir, name);
    git(dir, "clone", "-q", "--branch", ref, origin, target);
    return target;
  };
  const commit = (cwd: string, file: string, content: string, message: string, trailer = false) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", message, ...(trailer ? ["--trailer", "Chief-Spec-Writer: thr_writer"] : []));
    return git(cwd, "rev-parse", "HEAD");
  };
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "remote", "add", "origin", origin);
  commit(seed, "src/app.ts", "base\n", "base");
  git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-q", "-b", BRANCH);
  git(seed, "push", "-q", "origin", BRANCH);
  const subjects = (cwd: string, range: string) => git(cwd, "log", "--format=%s", range).split("\n").filter(Boolean);
  return { dir, origin, clone, commit, subjects, worker: clone("worker") };
}

type Fold = { status: "pushed"; pushed: string; U: string; attempts: number } | { status: "conflict"; H: string; B: string; U: string; output: string };
/** Section 10 as a script. `beforePush` runs between the successful rebase and the push of attempt n (it stands for origin moving in that window). */
function fold(cwd: string, base: string, beforePush: (attempt: number) => void = () => {}): Fold {
  let B = base;
  for (let n = 1; ; n += 1) {
    expect(git(cwd, "status", "--porcelain")).toBe("");
    git(cwd, "fetch", "-q", "origin", BRANCH);
    const U = git(cwd, "rev-parse", `origin/${BRANCH}`);
    const H = git(cwd, "rev-parse", "HEAD");
    const rebase = attempt(cwd, "rebase", "--no-autostash", "--onto", `origin/${BRANCH}`, B);
    if (rebase.status !== 0) {
      git(cwd, "rebase", "--quit");
      return { status: "conflict", H, B, U, output: rebase.output };
    }
    const changed = git(cwd, "diff", "--name-only", `${U}..HEAD`).split("\n").filter(Boolean);
    expect(changed.every((path) => path.startsWith("docs/")), `fold scope: ${changed.join()}`).toBe(true);
    beforePush(n);
    const push = attempt(cwd, "push", "origin", `HEAD:${BRANCH}`);
    if (push.status === 0) return { status: "pushed", pushed: git(cwd, "rev-parse", "HEAD"), U, attempts: n };
    B = U;
  }
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "spec-fold-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Spec Writer fold (section 10 command sequence, real git)", () => {
  test("a first fold publishes the worker's commits plus the writer's own docs commits, and only docs/ changed on top of the branch", () => {
    const w = world();
    w.commit(w.worker, "src/one.ts", "1\n", "worker one");
    w.commit(w.worker, "src/two.ts", "2\n", "worker two");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
    const writer = w.clone("writer");
    const base = git(writer, "rev-parse", "HEAD");
    w.commit(writer, "docs/specs/a.md", "a\n", "docs a", true);
    w.commit(writer, "docs/specs/b.md", "b\n", "docs b", true);
    w.commit(w.worker, "src/three.ts", "3\n", "worker three");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);

    const result = fold(writer, base);
    expect(result).toMatchObject({ status: "pushed", attempts: 1 });
    const pushed = (result as Extract<Fold, { status: "pushed" }>);
    expect(git(w.origin, "rev-parse", BRANCH)).toBe(pushed.pushed);
    expect(w.subjects(w.origin, `main..${BRANCH}`)).toEqual(["docs b", "docs a", "worker three", "worker two", "worker one"]);
    expect(git(writer, "diff", "--name-only", `${pushed.U}..${pushed.pushed}`).split("\n")).toEqual(["docs/specs/a.md", "docs/specs/b.md"]);
    // The docs commits kept their trailer; the worker's commits did not gain one.
    expect(git(w.origin, "log", "--format=%(trailers:key=Chief-Spec-Writer,valueonly)", `${pushed.U}..${BRANCH}`).split("\n").filter(Boolean)).toEqual(["thr_writer", "thr_writer"]);
    expect(git(w.origin, "log", "--format=%H", "--grep=Chief-Spec-Writer", `main..${pushed.U}`)).toBe("");
  });

  test("when the worker rewrote commits below the writer's Base, the fold publishes no inherited pre-Base commit, only the writer's docs commits on the new tip", () => {
    const w = world();
    const first = w.commit(w.worker, "src/one.ts", "original one\n", "worker one");
    const second = w.commit(w.worker, "src/two.ts", "original two\n", "worker two");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
    const writer = w.clone("writer");
    const base = git(writer, "rev-parse", "HEAD");
    expect(base).toBe(second);
    w.commit(writer, "docs/specs/a.md", "a\n", "docs a", true);

    // The worker rewrites both commits (new content, new ids) and force-pushes: this is the worker's own history, set up outside the fold.
    const rewritten = w.clone("rewritten", "main");
    git(rewritten, "switch", "-q", "-c", BRANCH);
    w.commit(rewritten, "src/one.ts", "rewritten one\n", "worker one");
    w.commit(rewritten, "src/two.ts", "rewritten two\n", "worker two");
    git(rewritten, "push", "-q", "--force", "origin", `HEAD:${BRANCH}`);
    const tip = git(rewritten, "rev-parse", "HEAD");

    // The earlier form of step 3 (replay everything not on origin) cannot publish this: control on a copy of the writer's checkout.
    const control = join(w.dir, "control");
    git(w.dir, "clone", "-q", writer, control);
    git(control, "remote", "set-url", "origin", w.origin);
    git(control, "fetch", "-q", "origin", BRANCH);
    expect(attempt(control, "rebase", "--no-autostash", `origin/${BRANCH}`).status).not.toBe(0);
    git(control, "rebase", "--quit");

    const result = fold(writer, base) as Extract<Fold, { status: "pushed" }>;
    expect(result.status).toBe("pushed");
    expect(result.U).toBe(tip);
    expect(w.subjects(w.origin, `main..${BRANCH}`)).toEqual(["docs a", "worker two", "worker one"]);
    expect(git(w.origin, "rev-parse", `${BRANCH}~1`)).toBe(tip);
    for (const old of [first, second]) expect(attempt(w.origin, "merge-base", "--is-ancestor", old, BRANCH).status).toBe(1);
    expect(git(writer, "diff", "--name-only", `${tip}..${result.pushed}`)).toBe("docs/specs/a.md");
  });

  test("a push rejected after a successful rebase is retried with B set to that attempt's U: one docs commit each, no product commits replayed, docs-only", () => {
    const w = world();
    w.commit(w.worker, "src/one.ts", "1\n", "worker one");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
    const writer = w.clone("writer");
    const base = git(writer, "rev-parse", "HEAD");
    w.commit(writer, "docs/specs/a.md", "a\n", "docs a", true);
    w.commit(writer, "docs/specs/b.md", "b\n", "docs b", true);
    let moved = "";
    const result = fold(writer, base, (n) => {
      if (n !== 1) return;
      // Origin moves between attempt 1's rebase and its push: the worker lands a product commit.
      w.commit(w.worker, "src/two.ts", "2\n", "worker two");
      git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
      moved = git(w.worker, "rev-parse", "HEAD");
    }) as Extract<Fold, { status: "pushed" }>;
    expect(result).toMatchObject({ status: "pushed", attempts: 2, U: moved });
    expect(git(w.origin, "rev-parse", BRANCH)).toBe(result.pushed);
    expect(w.subjects(w.origin, `main..${BRANCH}`)).toEqual(["docs b", "docs a", "worker two", "worker one"]);
    expect(git(writer, "diff", "--name-only", `${moved}..${result.pushed}`).split("\n")).toEqual(["docs/specs/a.md", "docs/specs/b.md"]);
    expect(git(w.origin, "log", "--format=%H", `main..${BRANCH}`).split("\n")).toHaveLength(4);
  });

  test("a conflict after a partial replay stops with git rebase --quit: no push, H stays reachable, and a fresh clone repairs the docs without the old checkout", () => {
    const w = world();
    w.commit(w.worker, "docs/shared.md", "shared\n", "worker adds shared");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
    const writer = w.clone("writer");
    const base = git(writer, "rev-parse", "HEAD");
    w.commit(writer, "docs/specs/ok.md", "ok\n", "docs ok", true);
    w.commit(writer, "docs/shared.md", "writer edit\n", "docs shared", true);
    const H = git(writer, "rev-parse", "HEAD");
    // Someone else's change to the same docs line lands first.
    w.commit(w.worker, "docs/shared.md", "other edit\n", "other docs edit");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
    const tip = git(w.worker, "rev-parse", "HEAD");

    const result = fold(writer, base);
    expect(result).toMatchObject({ status: "conflict", H, B: base, U: tip });
    expect((result as Extract<Fold, { status: "conflict" }>).output).toContain("docs/shared.md");
    // Nothing was published, the recorded H is still a commit of the checkout, and the quit left no rebase in progress.
    expect(git(w.origin, "rev-parse", BRANCH)).toBe(tip);
    expect(git(writer, "cat-file", "-t", H)).toBe("commit");
    expect(git(writer, "rev-parse", `refs/heads/${BRANCH}`)).toBe(H);
    expect(existsSync(join(writer, ".git", "rebase-merge"))).toBe(false);

    // The repair: a fresh clone cut from the task branch writes the delta again on the current docs and folds. The old checkout is left alone.
    const oldHead = git(writer, "rev-parse", "HEAD");
    const oldStatus = git(writer, "status", "--porcelain");
    const repair = w.clone("repair");
    const repairBase = git(repair, "rev-parse", "HEAD");
    expect(repairBase).toBe(tip);
    w.commit(repair, "docs/specs/ok.md", "ok\n", "docs ok again", true);
    w.commit(repair, "docs/shared.md", "merged edit\n", "docs shared again", true);
    const fixed = fold(repair, repairBase) as Extract<Fold, { status: "pushed" }>;
    expect(fixed).toMatchObject({ status: "pushed", attempts: 1, U: tip });
    expect(w.subjects(w.origin, `${tip}..${BRANCH}`)).toEqual(["docs shared again", "docs ok again"]);
    expect(git(repair, "diff", "--name-only", `${tip}..${fixed.pushed}`).split("\n")).toEqual(["docs/shared.md", "docs/specs/ok.md"]);
    expect(git(writer, "rev-parse", "HEAD")).toBe(oldHead);
    expect(git(writer, "status", "--porcelain")).toBe(oldStatus);
  });
});

// Plan wave 6/8: a same-plan side-lane repair gets one `## Docs work list` and folds the Spec delta, every listed item and the earlier writer's
// blocked work in that one attempt (section 10), never as separate fix and fold writers. Scripted against real repositories like the suite above.
describe("docs work list: a same-plan repair folds every known docs item once", () => {
  test("after a blocked first fold the repair writes the delta and each listed item, then one fold publishes them all, docs-only, with the trailer", () => {
    const w = world();
    w.commit(w.worker, "docs/shared.md", "shared\n", "worker adds shared");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
    // The first writer's fold conflicts with a docs edit that landed first: it reports blocked (its blocker is the first work-list line).
    const first = w.clone("first");
    const firstBase = git(first, "rev-parse", "HEAD");
    w.commit(first, "docs/shared.md", "writer edit\n", "docs shared", true);
    w.commit(w.worker, "docs/shared.md", "other edit\n", "other docs edit");
    git(w.worker, "push", "-q", "origin", `HEAD:${BRANCH}`);
    const tip = git(w.worker, "rev-parse", "HEAD");
    expect(fold(first, firstBase)).toMatchObject({ status: "conflict", U: tip });
    expect(git(w.origin, "rev-parse", BRANCH)).toBe(tip);

    // The repair: one fresh checkout from the branch writes the Spec delta plus two workers' `## Docs needed` items, then folds once.
    const repair = w.clone("repair");
    const base = git(repair, "rev-parse", "HEAD");
    expect(base).toBe(tip);
    w.commit(repair, "docs/shared.md", "merged edit\n", "docs: spec delta and the blocked fold's edit", true);
    w.commit(repair, "docs/specs/worker-item.md", "worker item\n", "docs: worker Docs needed item", true);
    w.commit(repair, "docs/specs/second-item.md", "second item\n", "docs: second worker Docs needed item", true);
    const result = fold(repair, base);
    expect(result).toMatchObject({ status: "pushed", attempts: 1, U: tip });
    const pushed = result as Extract<Fold, { status: "pushed" }>;
    expect(git(w.origin, "rev-parse", BRANCH)).toBe(pushed.pushed);
    expect(w.subjects(w.origin, `${tip}..${BRANCH}`)).toEqual(["docs: second worker Docs needed item", "docs: worker Docs needed item", "docs: spec delta and the blocked fold's edit"]);
    expect(git(repair, "diff", "--name-only", `${tip}..${pushed.pushed}`).split("\n")).toEqual(["docs/shared.md", "docs/specs/second-item.md", "docs/specs/worker-item.md"]);
    expect(git(w.origin, "log", "--format=%(trailers:key=Chief-Spec-Writer,valueonly)", `${tip}..${BRANCH}`).split("\n").filter(Boolean)).toEqual(["thr_writer", "thr_writer", "thr_writer"]);
  });

  test("a repair commit that touches a non-docs path is refused by the fold scope check and nothing is published", () => {
    const w = world();
    const writer = w.clone("repair");
    const base = git(writer, "rev-parse", "HEAD");
    const tip = git(w.origin, "rev-parse", BRANCH);
    w.commit(writer, "docs/specs/item.md", "item\n", "docs: item", true);
    w.commit(writer, "src/fix.ts", "fix\n", "fix a listed item in code", true);
    expect(() => fold(writer, base)).toThrow(/fold scope: .*src\/fix\.ts/);
    expect(git(w.origin, "rev-parse", BRANCH)).toBe(tip);
  });
});
