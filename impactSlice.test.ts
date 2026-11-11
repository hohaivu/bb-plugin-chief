import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { computeImpactSlice, type ImpactSliceSuccess } from "./src/review/impactSlice";

// Contracts (reviewer-prompt wave 1, step 5e): `changed` lists every path of `git diff --name-only -z --no-renames <merge-base> <sha>` (text, binary,
// mode-only, non-ASCII, raw); `docsHistory` is true when some non-merge commit of `<merge-base>..<sha>` touches docs/ (a revert does not erase it);
// a failed lookup is null, never `[]` or `false`, and the rest of the slice is what it is without the lookup.
// Every repository below is a real temporary Git repository; nothing is stubbed except the failing lookups, which a `git` shim on PATH fails.

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};

/** A repository whose `main` holds the base files; `branch` commits go on `feature`. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "impact-slice-test-"));
  roots.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: GIT_ENV, encoding: "utf8" }).trim();
  const put = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  git("init", "-q", "-b", "main");
  git("config", "core.fileMode", "true");
  git("config", "commit.gpgsign", "false");
  const commit = (message: string) => { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  return { dir, git, put, commit };
}

const SLICE_ARGS = (dir: string, sha: string, base: string, env: NodeJS.ProcessEnv = GIT_ENV) => ({ cwd: dir, sha, baseRef: base, env, maxEntries: 30, deadlineMs: 30_000 });
async function slice(dir: string, sha: string, base: string, env?: NodeJS.ProcessEnv) {
  const result = await computeImpactSlice(SLICE_ARGS(dir, sha, base, env));
  if ("skipped" in result) throw new Error(`slice skipped: ${result.skipped}`);
  return result;
}

/** The base: a library function with a caller, a file to delete, a script to chmod, a README and an AGENTS.md. */
function withBase() {
  const r = repo();
  r.put("src/lib.ts", "export function total(a: number): number {\n  return a;\n}\n");
  r.put("src/use.ts", "import { total } from \"./lib\";\nexport const two = total(2);\n");
  r.put("src/gone.ts", "export const gone = 1;\n");
  r.put("README.md", "# Title\n");
  r.put("AGENTS.md", "rules\n");
  r.put("tool.sh", "#!/bin/sh\necho hi\n");
  const base = r.commit("base");
  r.git("checkout", "-q", "-b", "feature");
  return { ...r, base };
}

describe("computeImpactSlice: changed paths from the Git listing", () => {
  test("an added, a modified and a deleted text file are all listed, once each", async () => {
    const r = withBase();
    r.put("src/lib.ts", "export function total(a: number, b: number): number {\n  return a + b;\n}\n");
    r.put("src/new.ts", "export const added = 1;\n");
    rmSync(join(r.dir, "src/gone.ts"));
    const head = r.commit("change");

    const result = await slice(r.dir, head, r.base);

    expect([...result.changed!].sort()).toEqual(["src/gone.ts", "src/lib.ts", "src/new.ts"]);
  });

  test("a binary-only docs file is a changed path and a docs history, though the text diff names no file", async () => {
    const r = withBase();
    r.put("docs/image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]));
    const head = r.commit("add image");

    const result = await slice(r.dir, head, r.base);

    expect(result.changed).toEqual(["docs/image.png"]);
    expect(result.docsHistory).toBe(true);
    // The text diff has no hunk: the early-return path carries both values.
    expect(result.entries).toBe(0);
    expect(result.lines[1]).toBe("No touched symbols or calls found in the diff.");
  });

  test("a mode-only change (chmod +x with core.fileMode on) is a changed path, though the text diff has no ---/+++ header", async () => {
    const r = withBase();
    chmodSync(join(r.dir, "tool.sh"), 0o755);
    const head = r.commit("make executable");
    expect(r.git("diff", "--summary", r.base, head)).toContain("mode change 100644 => 100755 tool.sh");

    const result = await slice(r.dir, head, r.base);

    expect(result.changed).toEqual(["tool.sh"]);
    expect(result.docsHistory).toBe(false);
  });

  test("a path with spaces, a quote and non-ASCII letters arrives raw, never quoted or escaped", async () => {
    const r = withBase();
    const path = "docs/ghi chú \"x\".md";
    r.put(path, "nội dung\n");
    const head = r.commit("add a vietnamese-named doc");

    const result = await slice(r.dir, head, r.base);

    expect(result.changed).toEqual([path]);
    expect(result.changed![0]!.startsWith("docs/")).toBe(true);
    expect(result.docsHistory).toBe(true);
  });

  test("a change with no touched symbol or call returns early, with the changed paths and the docs history of the range", async () => {
    const r = withBase();
    r.put("README.md", "# Title\n\nMore words.\n");
    const head = r.commit("readme");

    const result = await slice(r.dir, head, r.base);

    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]).toBe("No touched symbols or calls found in the diff.");
    expect(result.entries).toBe(0);
    expect(result.changed).toEqual(["README.md"]);
    expect(result.docsHistory).toBe(false);
  });

  test("a path changed only before the merge base is not listed", async () => {
    const r = repo();
    r.put("old.txt", "1\n");
    r.commit("first");
    r.put("old.txt", "2\n");
    r.put("src/lib.ts", "export const x = 1;\n");
    const base = r.commit("second, still on main");
    r.git("checkout", "-q", "-b", "feature");
    r.put("src/lib.ts", "export const x = 2;\n");
    const head = r.commit("feature");

    expect((await slice(r.dir, head, base)).changed).toEqual(["src/lib.ts"]);
  });
});

describe("computeImpactSlice: docs history of the range", () => {
  test("a docs/ file added and then removed leaves no docs/ path in the net diff, and the history still says docs", async () => {
    const r = withBase();
    r.put("docs/draft.md", "# Draft\n");
    r.put("src/lib.ts", "export function total(a: number, b: number): number {\n  return a + b;\n}\n");
    r.commit("add a draft doc and change code");
    rmSync(join(r.dir, "docs/draft.md"));
    const head = r.commit("remove the draft doc");
    expect(r.git("diff", "--name-only", r.base, head)).toBe("src/lib.ts");

    const result = await slice(r.dir, head, r.base);

    expect(result.changed).toEqual(["src/lib.ts"]);
    expect(result.docsHistory).toBe(true);
  });

  test("no docs/ commit in the range is false, even when the history before the merge base has one", async () => {
    const r = repo();
    r.put("docs/spec.md", "# Spec\n");
    r.put("src/lib.ts", "export const x = 1;\n");
    const base = r.commit("base with docs");
    r.git("checkout", "-q", "-b", "feature");
    r.put("src/lib.ts", "export const x = 2;\n");
    const head = r.commit("code only");

    const result = await slice(r.dir, head, base);

    expect(result.docsHistory).toBe(false);
    expect(result.changed).toEqual(["src/lib.ts"]);
  });

  test("a docs/ commit anywhere in the range is true, including the first commit of several", async () => {
    const r = withBase();
    r.put("docs/new.md", "# New\n");
    r.commit("docs first");
    r.put("src/new.ts", "export const n = 1;\n");
    r.commit("code second");
    r.put("src/new.ts", "export const n = 2;\n");
    const head = r.commit("code third");

    expect((await slice(r.dir, head, r.base)).docsHistory).toBe(true);
  });
});

describe("computeImpactSlice: a failed lookup is unknown (null), never empty or false", () => {
  /** A `git` that fails the path listing (`diff --name-only`; the guidelines' `ls-tree --name-only` is another command) or the docs history (`log --no-merges`) and runs the real one otherwise. */
  function shim() {
    const bin = mkdtempSync(join(tmpdir(), "impact-slice-shim-"));
    roots.push(bin);
    const script = join(bin, "git");
    writeFileSync(script, [
      "#!/bin/sh",
      "for arg in \"$@\"; do",
      "  case \"$arg\" in",
      "    --no-renames) [ \"$1\" = diff ] && case \" $* \" in *' --name-only '*) [ \"$CHIEF_FAIL\" = names ] || [ \"$CHIEF_FAIL\" = both ] && { echo 'names lookup failed' >&2; exit 2; } ;; esac ;;",
      "    --no-merges) [ \"$CHIEF_FAIL\" = history ] || [ \"$CHIEF_FAIL\" = both ] && { echo 'history lookup failed' >&2; exit 2; } ;;",
      "  esac",
      "done",
      "exec \"$REAL_GIT\" \"$@\"",
      "",
    ].join("\n"));
    chmodSync(script, 0o755);
    return (fail: "names" | "history" | "both" | "") => ({ ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, REAL_GIT, CHIEF_FAIL: fail });
  }

  /** The same change twice: its slice with every lookup working, and with the given one failing. */
  async function compare(fail: "names" | "history" | "both") {
    const r = withBase();
    r.put("src/lib.ts", "export function total(a: number, b: number): number {\n  return a + b;\n}\n");
    r.put("docs/note.md", "# Note\n");
    const head = r.commit("change code and docs");
    const env = shim();
    const ok = await slice(r.dir, head, r.base, env(""));
    const failed = await slice(r.dir, head, r.base, env(fail));
    return { ok, failed };
  }
  const rest = (result: ImpactSliceSuccess) => ({ lines: result.lines, entries: result.entries, guidelines: result.guidelines });

  test("the shim itself changes nothing while no lookup is asked to fail", async () => {
    const { ok } = await compare("names");
    expect([...ok.changed!].sort()).toEqual(["docs/note.md", "src/lib.ts"]);
    expect(ok.docsHistory).toBe(true);
    expect(ok.entries).toBeGreaterThan(0);
  });

  test("a failed path listing: changed is null, the docs history is still read, and lines, entries and guidelines are the slice's own", async () => {
    const { ok, failed } = await compare("names");
    expect(failed.changed).toBeNull();
    expect(failed.docsHistory).toBe(true);
    expect(rest(failed)).toEqual(rest(ok));
  });

  test("a failed docs history: docsHistory is null, changed is still listed, and the rest is the slice's own", async () => {
    const { ok, failed } = await compare("history");
    expect(failed.docsHistory).toBeNull();
    expect([...failed.changed!].sort()).toEqual(["docs/note.md", "src/lib.ts"]);
    expect(rest(failed)).toEqual(rest(ok));
  });

  test("both lookups failing give two nulls and a slice that still succeeds", async () => {
    const { ok, failed } = await compare("both");
    expect(failed.changed).toBeNull();
    expect(failed.docsHistory).toBeNull();
    expect(rest(failed)).toEqual(rest(ok));
  });

  test("a failed lookup on the early-return path is null as well", async () => {
    const r = withBase();
    r.put("README.md", "# Title\n\nMore.\n");
    const head = r.commit("readme");
    const env = shim();

    const result = await slice(r.dir, head, r.base, env("both"));

    expect(result.entries).toBe(0);
    expect(result.changed).toBeNull();
    expect(result.docsHistory).toBeNull();
  });
});
