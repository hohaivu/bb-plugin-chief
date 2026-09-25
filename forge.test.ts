import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { forgeInitScript } from "./forge";

describe("forgeInitScript", () => {
  test("slugs a title into a task branch", () => {
    expect(forgeInitScript({ title: 'Fix "checkout" totals & tax' }).branch)
      .toBe("feature/fix-checkout-totals-tax");
  });

  test("quotes a title the shell would otherwise eat", () => {
    const { script } = forgeInitScript({ title: "Chief's forge; rm -rf /" });
    expect(script).toContain("TITLE='Chief'\\''s forge; rm -rf /'");
    // The generated script is the whole point of the tool: if it does not parse,
    // every delegation's branch is wrong in a way no prompt can fix.
    execFileSync("sh", ["-n"], { input: script });
  });

  test("honours an explicit base and falls back to the default branch otherwise", () => {
    expect(forgeInitScript({ title: "Stack on the open PR", base: "feature/audit-p2" }).script)
      .toContain("BASE='feature/audit-p2'");
    const { script } = forgeInitScript({ title: "Ordinary work" });
    expect(script).toContain("BASE=''");
    expect(script).toContain("refs/remotes/origin/HEAD");
    expect(script).toContain("git commit-tree");
  });

  test("reports what it created on one machine-readable line", () => {
    const { script } = forgeInitScript({ title: "Ordinary work" });
    expect(script).toContain("CHIEF_FORGE branch=%s base=%s issue_url=%s pr_url=%s forge=%s");
    execFileSync("sh", ["-n"], { input: script });
  });
});
