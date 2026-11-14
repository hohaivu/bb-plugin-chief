import { beforeEach, describe, expect, test, vi } from "vitest";
import { execFileMock } from "./test/execMock";
import { prMerged } from "./src/forge/forge";

vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());

// Contract (wave 1, src/forge/forge.ts prMerged): the merged state and the PR head commit from whichever forge CLI hosts the PR.
// `head` is trimmed, lowercased and null unless it is a valid sha; null overall when no forge CLI could say.
const GITHUB_PR = "https://github.com/acme/shop/pull/8";
const GITLAB_MR = "https://gitlab.example.com/acme/shop/-/merge_requests/3";
const SHA = "ab12cd34".repeat(5);

/** Answers each CLI from `replies`; a missing entry (or `Error`) makes that CLI fail. */
const forges = (replies: { gh?: unknown; glab?: unknown }) => execFileMock.mockImplementation(async (file: string) => {
  const reply = replies[file as "gh" | "glab"];
  if (reply === undefined || reply instanceof Error) throw reply ?? new Error(`${file} unavailable`);
  return { stdout: typeof reply === "string" ? reply : JSON.stringify(reply), stderr: "" };
});
const calls = (file: string) => execFileMock.mock.calls.filter((call) => call[0] === file).map((call) => call[1] as string[]);
beforeEach(() => { execFileMock.mockReset(); }); // not an arrow returning the mock: vitest would call it as a cleanup

describe("prMerged", () => {
  test("GitHub: asks for state and headRefOid, reports merged and the head", async () => {
    forges({ gh: { state: "MERGED", headRefOid: SHA } });
    expect(await prMerged(GITHUB_PR, "/repo")).toEqual({ merged: true, head: SHA });
    expect(calls("gh")).toEqual([["pr", "view", "8", "--json", "state,headRefOid", "--repo", "acme/shop"]]);
  });

  test("GitHub: an open PR is not merged, and still reports its head", async () => {
    forges({ gh: { state: "OPEN", headRefOid: SHA } });
    expect(await prMerged(GITHUB_PR, "/repo")).toEqual({ merged: false, head: SHA });
  });

  test("GitHub: the head is trimmed and lowercased", async () => {
    forges({ gh: { state: "MERGED", headRefOid: `  ${SHA.toUpperCase()}\n` } });
    expect(await prMerged(GITHUB_PR, "/repo")).toEqual({ merged: true, head: SHA });
  });

  test.each<[string, { headRefOid?: string }]>([
    ["missing", {}],
    ["empty", { headRefOid: "" }],
    ["not a sha", { headRefOid: "not-a-sha" }],
    ["too short", { headRefOid: "abc12" }],
  ])("GitHub: a head that is %s gives head null, the merged state is kept", async (_name, extra) => {
    forges({ gh: { state: "MERGED", ...extra } });
    expect(await prMerged(GITHUB_PR, "/repo")).toEqual({ merged: true, head: null });
  });

  test("GitLab: takes the head from sha, else from diff_refs.head_sha", async () => {
    forges({ glab: { state: "merged", sha: SHA, diff_refs: { head_sha: "f".repeat(40) } } });
    expect(await prMerged(GITLAB_MR, "/repo")).toEqual({ merged: true, head: SHA });
    expect(calls("glab")).toEqual([["mr", "view", "3", "-F", "json", "--repo", "acme/shop"]]);
    forges({ glab: { state: "opened", diff_refs: { head_sha: SHA } } });
    expect(await prMerged(GITLAB_MR, "/repo")).toEqual({ merged: false, head: SHA });
  });

  test("an unknown host tries gh, then glab, and uses the first CLI that answers", async () => {
    forges({ glab: { state: "merged", sha: SHA } });
    expect(await prMerged("#12", null)).toEqual({ merged: true, head: SHA });
    expect(calls("gh")).toHaveLength(1);
    expect(calls("glab")).toHaveLength(1);
  });

  test.each([
    ["both CLIs fail", {}],
    ["the CLI prints something that is not JSON", { gh: "not json", glab: "not json" }],
  ])("%s: unknown, null", async (_name, replies) => {
    forges(replies);
    expect(await prMerged("#12", null)).toBeNull();
  });
});
