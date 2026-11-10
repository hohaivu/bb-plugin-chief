import { afterEach, describe, expect, test, vi } from "vitest";
import { delegate, disposeAll } from "./test/harness";
import { NO_TESTER, PR, type World, world } from "./test/docsGateWorld";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { readyIdle, refusal, reviewed, tool } from "./test/testerHelpers";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts C7, C8, C9 (plan wave 1, "Only the Spec Writer edits docs/ everywhere"), through the real `chief_complete` tool and `markComplete`.
// The project path is a real clone with a bare origin; git runs for real (recorded), gh answers from a stub. Source of truth: docs/specs/plan-chains.md, "Docs Ownership".
describe("skipReview docs/ ownership gate", () => {
  /** The unplanned task chain W (worker) -> S (implementation-lane Spec Writer) -> F (worker): S is a Spec Writer of F's task. */
  async function chain(w: World) {
    const first = await w.worker("Fix checkout totals");
    const writer = await w.worker("Docs for totals", { replaces: first, kind: "spec-writer" });
    const fix = await w.worker("Finish totals", { replaces: writer, kind: "worker" });
    return { first, writer, fix };
  }

  test("C7: a docs/ commit with no trailer refuses skipReview, lists the commit and the three routes, and leaves the worker running", async () => {
    const w = await world();
    const id = await w.worker("Fix checkout totals");
    const offending = await w.commit("docs/specs/totals.md", "docs: totals by a worker");
    const message = await refusal(w.call("chief_complete", { threadId: id, skipReview: "small change", ...NO_TESTER }));
    expect(message).toContain(`${offending.slice(0, 9)} docs: totals by a worker (docs/specs/totals.md)`);
    expect(message).toContain("the branch has docs/ commits no Spec Writer of this task is recorded on");
    expect(message).toContain(`chief_review (workerThreadId: ${id})`);
    expect(message).toContain(`replaces: ${id}, kind: spec-writer)`);
    expect(message).toContain("override with your reason");
    expect(w.rowState(id)).not.toBe("complete");
  });

  test("C7: the repair route runs end to end: refused, a writer correction (trailer) still refused, then an approve completes without skipReview", async () => {
    const w = await world();
    const first = await w.worker("Fix checkout totals");
    const offending = await w.commit("docs/specs/totals.md", "docs: totals by a worker");
    expect(await refusal(w.call("chief_complete", { threadId: first, skipReview: "small change", ...NO_TESTER }))).toContain(offending.slice(0, 9));
    // Chief takes the advertised route: a Spec Writer (replacing the worker), whose correction commit carries its trailer; a worker then follows.
    const writer = await w.worker("Docs for totals", { replaces: first, kind: "spec-writer" });
    const correction = await w.commit("docs/specs/totals.md", "docs: correct the totals spec", writer);
    const fix = await w.worker("Finish totals", { replaces: writer, kind: "worker" });
    // History is append-only: the correction does not cure the offending commit, only the offending commit is named.
    const again = await refusal(w.call("chief_complete", { threadId: fix, skipReview: "small change", ...NO_TESTER }));
    expect(again).toContain(offending.slice(0, 9));
    expect(again).not.toContain(correction.slice(0, 9));
    expect(w.rowState(fix)).not.toBe("complete");
    // The reviewer's approve is the cure: chief_complete without skipReview runs no docs check and completes.
    await reviewed(w.state, w.chief.threadId, fix, "approve");
    w.gitCalls.length = 0;
    const done = await w.call("chief_complete", { threadId: fix, ...NO_TESTER });
    expect(done).toContain("complete");
    expect(w.rowState(fix)).toBe("complete");
    expect(w.docsReads()).toEqual([]);
  });

  test.each([
    ["a worker row", async (w: World) => {
      const { first, fix } = await chain(w);
      return { subject: fix, trailer: first };
    }],
    ["a Spec Writer of another task", async (w: World) => {
      const other = await w.worker("Another task", { branch: "other" });
      const foreign = await w.worker("Docs for the other task", { replaces: other, kind: "spec-writer", branch: "other" });
      return { subject: await w.worker("Task under test"), trailer: foreign };
    }],
  ])("C7: a trailer naming %s is not a Spec Writer of this task: refused", async (_label, arrange) => {
    const w = await world();
    const { subject, trailer } = await arrange(w);
    const offending = await w.commit("docs/specs/x.md", "docs: tagged by someone else", trailer);
    expect(await refusal(w.call("chief_complete", { threadId: subject, skipReview: "small change", ...NO_TESTER }))).toContain(offending.slice(0, 9));
  });

  test("C8: every docs/ commit names a Spec Writer of this task: skipReview succeeds with no note", async () => {
    const w = await world();
    const { writer, fix } = await chain(w);
    await w.commit("docs/specs/a.md", "docs: first", writer);
    await w.commit("docs/specs/b.md", "docs: second", writer);
    const reply = await w.call("chief_complete", { threadId: fix, skipReview: "small change", ...NO_TESTER });
    expect(reply).toContain("without a review (reason recorded)");
    expect(reply).not.toContain("docs/ check skipped");
    expect(w.docsReads()).toHaveLength(1);
  });

  test("C8: no docs/ commit on the branch: skipReview succeeds with no note", async () => {
    const w = await world();
    const id = await w.worker("Fix checkout totals");
    const reply = await w.call("chief_complete", { threadId: id, skipReview: "small change", ...NO_TESTER });
    expect(reply).toContain("without a review (reason recorded)");
    expect(reply).not.toContain("docs/ check skipped");
    expect(w.docsReads()).toHaveLength(1);
  });

  describe("C8: when the check cannot run, skipReview still completes and the tool reply says why", () => {
    const SKIPPED = /docs\/ check skipped: (.+); skipReview proceeded without it\./;
    test("the project has no checkout path on the plugin server", async () => {
      const w = await world({ path: false });
      const id = await w.worker("Fix checkout totals");
      const reply = await w.call("chief_complete", { threadId: id, skipReview: "small change", ...NO_TESTER });
      expect(reply).toMatch(SKIPPED);
      expect(reply).toContain("docs/ check skipped: no local checkout of the project on the plugin server");
      expect(w.rowState(id)).toBe("complete");
    });
    test("the project checkout is on a remote host: an offending commit is not read", async () => {
      const w = await world({ primaryHostId: "host_elsewhere" });
      const id = await w.worker("Fix checkout totals");
      await w.commit("docs/specs/totals.md", "docs: totals by a worker");
      const reply = await w.call("chief_complete", { threadId: id, skipReview: "small change", ...NO_TESTER });
      expect(reply).toContain("docs/ check skipped: the project checkout is on a remote host, not the plugin server");
      expect(w.rowState(id)).toBe("complete");
      expect(w.docsReads()).toEqual([]);
    });
    test("the pull request head cannot be read from the forge", async () => {
      const w = await world({ ghHead: () => new Error("gh: HTTP 502") });
      const id = await w.worker("Fix checkout totals", { prUrl: PR });
      await w.commit("docs/specs/totals.md", "docs: totals by a worker");
      const reply = await w.call("chief_complete", { threadId: id, skipReview: "small change", ...NO_TESTER });
      expect(reply).toContain("docs/ check skipped: cannot read the pull request head from the forge");
      expect(w.rowState(id)).toBe("complete");
      expect(w.docsReads()).toEqual([]);
    });
    test("the task has no branch", async () => {
      const w = await world();
      const row = await delegate(w.state, w.chief.threadId, "No branch");
      await readyIdle(w.state, row.threadId, "Done");
      const reply = await w.call("chief_complete", { threadId: row.threadId, skipReview: "small change", ...NO_TESTER });
      expect(reply).toContain("docs/ check skipped: no task branch");
    });
    test("the branch cannot be fetched from origin", async () => {
      const w = await world();
      const row = await delegate(w.state, w.chief.threadId, "Unpushed", { branch: "never-pushed" });
      await readyIdle(w.state, row.threadId, "Done");
      const reply = await w.call("chief_complete", { threadId: row.threadId, skipReview: "small change", ...NO_TESTER });
      expect(reply).toContain("docs/ check skipped: could not fetch origin/never-pushed");
    });
  });

  test("a pull request task is read at the PR head sha against the PR base, not at origin/<branch>", async () => {
    let head = "";
    const w = await world({ ghHead: () => JSON.stringify({ headRefName: "task", headRefOid: head, baseRefName: "main" }) });
    const id = await w.worker("Fix checkout totals", { prUrl: PR });
    // The PR head predates the offending commit that was pushed afterwards.
    head = await w.headSha();
    await w.commit("docs/specs/late.md", "docs: pushed after the PR head");
    const reply = await w.call("chief_complete", { threadId: id, skipReview: "small change", ...NO_TESTER });
    expect(reply).not.toContain("docs/ check skipped");
    expect(w.rowState(id)).toBe("complete");
  });

  describe("C9: approve, override and CLI override run no docs check", () => {
    test("approve", async () => {
      const w = await world();
      const id = await w.worker("Fix checkout totals");
      await w.commit("docs/specs/totals.md", "docs: totals by a worker");
      await reviewed(w.state, w.chief.threadId, id, "approve");
      w.gitCalls.length = 0;
      await w.call("chief_complete", { threadId: id, ...NO_TESTER });
      expect(w.rowState(id)).toBe("complete");
      expect(w.docsReads()).toEqual([]);
    });
    test("override", async () => {
      const w = await world();
      const id = await w.worker("Fix checkout totals");
      await w.commit("docs/specs/totals.md", "docs: totals by a worker");
      w.gitCalls.length = 0;
      const reply = await w.call("chief_complete", { threadId: id, override: "the user accepted it", ...NO_TESTER });
      expect(reply).toContain("without a matching approve");
      expect(reply).not.toContain("docs/ check skipped");
      expect(w.rowState(id)).toBe("complete");
      expect(w.docsReads()).toEqual([]);
    });
    test("CLI override", async () => {
      const w = await world();
      // The CLI has no testsSkipped flag: the unplanned task needs its tester, and the tester is what completes.
      const worker = await w.worker("Fix checkout totals");
      const id = await w.worker("Tests for totals", { replaces: worker, kind: "tester" });
      await w.commit("docs/specs/totals.md", "docs: totals by a worker");
      w.gitCalls.length = 0;
      const result = await w.state.harness.behavior.runCli(["complete", id, "--override", "the user accepted it"], { threadId: w.chief.threadId, projectId: "proj_1" });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("without a matching approve");
      expect(w.rowState(id)).toBe("complete");
      expect(w.docsReads()).toEqual([]);
    });
  });
});
