import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { forgeInitScript } from "../src/forge/forge";

describe("forgeInitScript", () => {
  test("slugs a title into a task branch", () => {
    expect(forgeInitScript({ title: 'Fix "checkout" totals & tax' }).branch)
      .toBe("feature/fix-checkout-totals-tax");
  });

  test("keeps titles that differ only in non-Latin letters or past the cut on separate branches", () => {
    const branch = (title: string) => forgeInitScript({ title }).branch;
    expect(branch("Café menu")).toBe("feature/cafe-menu");
    expect(branch("修复结账")).not.toBe(branch("修复登录"));
    expect(branch("修复结账")).toMatch(/^feature\/task-[0-9a-f]{8}$/);
    const long = "Refactor the checkout totals pipeline so every tax rule is applied once";
    expect(branch(`${long} in carts`)).not.toBe(branch(`${long} in orders`));
    expect(branch(`${long} in carts`).length).toBeLessThanOrEqual("feature/".length + 60);
  });

  test("quotes a title the shell would otherwise eat", () => {
    const { script } = forgeInitScript({ title: "Chief's forge; rm -rf /" });
    expect(script).toContain("TITLE='Chief'\\''s forge; rm -rf /'");
    // The generated script is the whole point of the tool: if it does not parse,
    // every delegation's branch is wrong in a way no prompt can fix.
    execFileSync("sh", ["-n"], { input: script });
  });

  test("substitutes an explicit base", () => {
    expect(forgeInitScript({ title: "Stack on the open PR", base: "feature/audit-p2" }).script)
      .toContain("BASE='feature/audit-p2'");
  });
});

// The reused-pull-request design check runs the real script against a fake `gh` (docs/specs/plan-chains.md "Pull request body": a reused pull request without the marker has its body rewritten;
// if the marker is still missing the script reports design=missing).
describe("forgeInitScript design marker", () => {
  const MARKER = "<!-- chief-design thr_9 r2 -->";
  const BODY = `Plan block\n\n${MARKER}\nDesign text`;
  const PR = "https://github.example/org/repo/pull/7";

  /** Runs the script in a fresh clone-like repo whose origin is a GitHub URL, with a fake gh. `pr` is the open pull request's body before the run (null: none open). */
  function run(options: { designMarker?: string; pr: string | null; editFails?: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "forge-design-"));
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    mkdirSync(bin);
    mkdirSync(repo);
    const gh = `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "issue list") ;;
  "issue create") echo https://github.example/org/repo/issues/1 ;;
  "pr list") [ -f "${dir}/pr-body" ] && echo "${PR}" ;;
  "pr create") printf '%s' "$*" > "${dir}/pr-body"; echo "${PR}" ;;
  "pr view") cat "${dir}/pr-body" ;;
  "pr edit") ${options.editFails ? "exit 1" : `shift 3; [ "$1" = --body ] && printf '%s' "$2" > "${dir}/pr-body"`} ;;
esac
`;
    writeFileSync(join(bin, "gh"), gh, { mode: 0o755 });
    if (options.pr !== null) writeFileSync(join(dir, "pr-body"), options.pr);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("remote", "add", "origin", "https://github.example/org/repo.git");
    const { script } = forgeInitScript({ title: "Wave 1", base: "main", body: BODY, designMarker: options.designMarker });
    const out = execFileSync("sh", ["-c", script], { cwd: repo, env }).toString();
    const calls = existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean) : [];
    return { design: /design=(\S*)/.exec(out)?.[1], prUrl: /pr_url=(\S*)/.exec(out)?.[1], calls, calledWith: (prefix: string) => calls.filter((call) => call.startsWith(prefix)) };
  }

  // Regression: a reused pull request without the design block is handed to Chief as designed, or its body is never rewritten.
  test("a reused pull request without the marker has its body rewritten and reports design=ok", () => {
    const result = run({ designMarker: MARKER, pr: "Plan block only" });
    expect(result.calledWith("pr edit")).toHaveLength(1);
    expect(result.calledWith("pr edit")[0]).toContain(PR);
    expect(result).toMatchObject({ design: "ok", prUrl: PR });
  });

  test("a reused pull request whose body cannot be rewritten reports design=missing", () => {
    const result = run({ designMarker: MARKER, pr: "Plan block only", editFails: true });
    expect(result.calledWith("pr edit")).toHaveLength(1);
    expect(result.design).toBe("missing");
  });

  test("a reused pull request that already has the marker is left alone and reports design=ok", () => {
    const result = run({ designMarker: MARKER, pr: BODY });
    expect(result.calledWith("pr edit")).toEqual([]);
    expect(result.design).toBe("ok");
  });

  test("a new pull request is created with the body and is never checked or edited", () => {
    const result = run({ designMarker: MARKER, pr: null });
    expect(result.calledWith("pr create")).toHaveLength(1);
    expect(result.calledWith("pr view")).toEqual([]);
    expect(result.calledWith("pr edit")).toEqual([]);
    expect(result.design).toBe("ok");
  });

  // Regression: the design check running for a plan with no design, which would rewrite its reused pull request body.
  test("with no marker a reused pull request is never viewed or edited", () => {
    const result = run({ pr: "Existing body" });
    expect(result.calledWith("pr view")).toEqual([]);
    expect(result.calledWith("pr edit")).toEqual([]);
    expect(result.design).toBe("");
  });
});
