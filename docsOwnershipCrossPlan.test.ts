import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { TEST_WAVE, disposeAll } from "./test/harness";
import { provideSdk } from "./test/sdk";
import { NO_TESTER, type World, git, world } from "./test/docsGateWorld";
import { delegateWave, plan, readyIdle, refusal, rowOf, tool, workerOn } from "./test/testerHelpers";
import { putWriter, specImpl, writerOn } from "./test/specWriterHelpers";
import { OWNERSHIP_PARAGRAPH } from "./test/docsOwnership";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Finding 1 of review 1 (contract C3, C4, C7; plan wave 1 "Only the Spec Writer edits docs/ everywhere"): the real cross-plan writer recovery P -> Q through the ledger.
// Plan P's side-lane Spec Writer S is blocked; a fresh plan Q's wave 1 Spec Writer T replaces S (the freshPlan exception) on the same branch; Q's worker W and tester X follow.
// X's replaces: chain then reaches S, a writer of ANOTHER plan. S must stay out of taskWriters (so out of the rendered `## Docs ownership`), and S's trailer must not excuse a docs/ commit
// when X completes with skipReview. Regression: taskWriters keeps every writer in the replaces chain whatever its plan.
describe("cross-plan writer recovery P -> Q", () => {
  async function recovered(w: World) {
    const { state, chief } = w;
    const planP = await plan(state, chief.threadId, [specImpl(1), TEST_WAVE(2)]);
    await delegateWave(state, chief.threadId, planP.threadId, 1, { kind: "spec-writer", branch: "task" });
    const s = writerOn(state, planP.threadId, 1).thread_id as string;
    await putWriter(state, chief.threadId, s, "blocked");
    const planQ = await plan(state, chief.threadId, [specImpl(1), TEST_WAVE(2)]);
    await delegateWave(state, chief.threadId, planQ.threadId, 1, { replaces: s, kind: "spec-writer" });
    const t = writerOn(state, planQ.threadId, 1).thread_id as string;
    return { s, t, planP, planQ };
  }
  /** Q's worker W continues T's task: its replaces: chain is W -> T -> S (the ledger walks replaces:; set directly, as no admitted call makes a worker replace a side-lane writer).
   * Plan Q's test wave is skipped so that W can complete. T and W are ready and idle. */
  async function ready(w: World) {
    const r = await recovered(w);
    const { state, chief } = w;
    await delegateWave(state, chief.threadId, r.planQ.threadId, 1, { branch: "task" });
    const worker = workerOn(state, r.planQ.threadId, 1).thread_id as string;
    state.db.prepare("UPDATE managed_threads SET replaces_thread_id=? WHERE thread_id=?").run(r.t, worker);
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, chief.threadId);
    await tool(state, "chief_skip_tests", { planThreadId: r.planQ.threadId, wave: 2, reason: "no tests here" }, chief.threadId);
    await readyIdle(state, r.t);
    await readyIdle(state, worker);
    return { ...r, worker };
  }
  const skip = (w: World, id: string) => w.call("chief_complete", { threadId: id, skipReview: "small change" });

  test("the recovery is real: T replaces S, S is plan P's writer and still blocked, T is plan Q's", async () => {
    const w = await world();
    const { s, t, planP, planQ } = await recovered(w);
    expect(rowOf(w.state, t)).toMatchObject({ plan_thread_id: planQ.threadId, plan_wave: 1, kind: "spec-writer", replaces_thread_id: s });
    expect(rowOf(w.state, s)).toMatchObject({ plan_thread_id: planP.threadId, kind: "spec-writer" });
  });

  test("S's trailer does not authorize Q's skipReview: refused, naming the commit", async () => {
    const w = await world();
    const { s, worker } = await ready(w);
    const offending = await w.commit("docs/specs/x.md", "docs: by the other plan's writer", s);
    const message = await refusal(skip(w, worker));
    expect(message).toContain(`${offending.slice(0, 9)} docs: by the other plan's writer (docs/specs/x.md)`);
    expect(w.rowState(worker)).not.toBe("complete");
  });

  test("control: T's own trailer authorizes it, so the refusal above is about S and nothing else", async () => {
    const w = await world();
    const { t, worker } = await ready(w);
    await w.commit("docs/specs/x.md", "docs: by T", t);
    expect(await skip(w, worker)).toContain("without a review (reason recorded)");
    expect(w.rowState(worker)).toBe("complete");
  });

  test("the review prompt's `## Docs ownership` names T and never S, though S is in T's replaces: chain", async () => {
    const w = await world();
    const { s, t, worker } = await ready(w);
    await tool(w.state, "chief_review", { workerThreadId: worker }, w.chief.threadId);
    const prompt = w.state.spawned.at(-1).prompt as string;
    const ownership = prompt.split("\n## Docs ownership\n")[1]!.split("\n")[0]!;
    expect(ownership).toBe(OWNERSHIP_PARAGRAPH(t));
    expect(ownership).not.toContain(s);
  });
});

// Finding 2 of review 1 (contract C6/C8): the task branch fetches, the default base cannot (origin's main is gone while the cached origin/HEAD still names it).
// The check must skip, not diff against a stale base, and the `chief_complete` reply must say so.
describe("default-base fetch failure", () => {
  /** origin's HEAD moves to the task branch and `main` is deleted there: `git fetch origin task` works, `git fetch origin main` fails, and work's origin/HEAD still names origin/main. */
  async function withoutDefaultBase(w: World) {
    const origin = (await git(w.workDir, "remote", "get-url", "origin"));
    await git(origin, "symbolic-ref", "HEAD", "refs/heads/task");
    await git(origin, "update-ref", "-d", "refs/heads/main");
    return origin;
  }
  test("docs commits are not read: the reply shows the skipped note and the task completes", async () => {
    const w = await world();
    const id = await w.worker("Fix checkout totals");
    await w.commit("docs/specs/totals.md", "docs: totals by a worker");
    await withoutDefaultBase(w);
    const reply = await w.call("chief_complete", { threadId: id, skipReview: "small change", ...NO_TESTER });
    expect(reply).toContain("docs/ check skipped: could not fetch origin/main; skipReview proceeded without it.");
    expect(reply).toContain("without a review (reason recorded)");
    expect(w.rowState(id)).toBe("complete");
    expect(w.docsReads()).toEqual([]);
  });
});
