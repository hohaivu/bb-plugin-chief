import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import plugin from "./server";
import { roster, specImpl } from "./test/specWriterHelpers";
import { plan, planWave, readyIdle, report, reviewed, tool } from "./test/testerHelpers";
import { HEAD_SHA, REQUEST_CHANGES, TEST_WAVE, approvePlan, disposeAll, execFileMock, legacyWave, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { shrinkAlerts } from "./test/shrinkEdits";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  describe("Spec Writer role", () => {
    // ---- Reviewer advice: characterization on base 626c3cd (tests first, before planProgress.reviewAdvice takes the repair decision) ----
    // Contract: for each case below, the reviewer's ready-report alert (nextAction forAlert = true, as Chief received it) and the
    // reviewer's chief_roster Pending line (forAlert = false, whole) give the text saved in test/fixtures/reviewer-advice-626c3cd.txt;
    // a null decision shows no Pending line and the alert's fallback. The real handlers run (chief_review, chief_report,
    // chief_roster, chief_delegate); nothing is observed through a production seam. The storage root is normalized and the forge is
    // execFileMock. A reviewer's carried reject_streak is set in SQL before its report (the report adds one), so the rung does not depend
    // on replacement rounds; a streak or verdict edited after the report is read once a later write reloads the row cache.
    // Regression: moving the repair decision changes a sentence, the layout it picks (plan, single, branch), the stack grouping, the
    // tester or spec routes, the rung, or that an approve wins over a streak.
    // Base capture (the same fixture, byte for byte, produced the snapshot on base and is compared on head):
    //   base: 626c3cdf5af8fcbf2e02b0e4e83b537b1813d811, a Worktrunk checkout (since removed) at /Volumes/VuHo_T5/Develop/personal/research/bb-plugin-chief.tester-base2-626c3cd;
    //     runner root = that directory; this server.test.ts with its oracle assertion swapped to write the output; `npx vitest run server.test.ts -t "reviewer advice oracle"` exit 0 (1 passed); `npx tsc --noEmit` exit 0 (0 errors).
    //   head: 6807ccc3e1c5b6601b2def281d4abdc73eed9a07 + this commit's test changes (production tree = e031902), cwd and runner root /Volumes/VuHo_T5/.bb/plugins/environment-worktrunk/host-data/worktrees/thr_qd8mstf97i-1/bb-plugin-chief;
    //     `npx vitest run server.test.ts -t "reviewer advice"` exit 0 (2 passed) against the snapshot copied unchanged from the base run.
    //   fixture block sha256 (between the markers), base and head: cddcc6046b3d7a41fb03cedebb6b2c66e16dd79885e02fa26b4fb23e292f6bd4; snapshot sha256: 49769900d73f6615d01a81303bf0368bd83ff07f3f95ec7e5a3fee9a72895069.
    //   Pending only, not alert: "no verdict" (no accepted report reaches a ready reviewer without a verdict) and "approve carrying streak 3" (an approve report resets the streak before its alert).
    // <reviewer-advice-oracle-begin>
    // These three blocks build a planned spec chain the old way (the Spec Writer first, its worker replacing it); the Spec Writer now runs
    // beside its worker as a side-lane target, so their recorded advice is no longer the contract. Their successors are the C3 repair-grouping
    // tests in specWriterRouting.test.ts, which run through the same chief_review / chief_report / chief_delegate path. Every other block stays byte for byte.
    const REPLACED_BY_PARALLEL_LANE = (name: string) => name.endsWith("a planned spec chain");
    const reviewerAdviceFixture = async () => {
      const blocks: string[] = [];
      const PR = "https://github.com/acme/shop/pull/8";
      const run = async (name: string, body: (k: any) => Promise<void>) => {
        if (REPLACED_BY_PARALLEL_LANE(name)) return;
        const state = await setup();
        await state.harness.behavior.setSettings({ cleanupApproved: true });
        const lines: string[] = [];
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${text.replaceAll(state.storageRoot, "<storage>")}`);
        execFileMock.mockReset();
        execFileMock.mockImplementation(async (file: string, args: string[]) => {
          if (file === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: HEAD_SHA, baseRefName: "main" }), stderr: "" };
          if (file === "gh" && args[0] === "pr" && args[1] === "ready") return { stdout: "", stderr: "" };
          throw new Error(`unexpected CLI ${file}`);
        });
        const newestWorker = () => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const k = {
          state, emit,
          chief: async () => (await start(state)).threadId,
          /** Chief plus a planner holding `waves`, approved when it has more than one implementation wave; test waves in `waived` are skipped. */
          mk: async (waves: object[], waived: number[] = []) => {
            const chief = (await start(state)).threadId;
            const planner = (await plan(state, chief, waves)).threadId;
            if (waves.filter((entry: any) => !entry.test && !entry.design).length > 1) await approvePlan(state, chief, planner);
            for (const wave of waived) await tool(state, "chief_skip_tests", { planThreadId: planner, wave, reason: "oracle reason" }, chief);
            return { chief, planner };
          },
          /** Delegates a worker (unplanned unless `extra` carries a plan or replaces), reports ready, goes idle: its id. */
          worker: async (chief: string, extra: object = {}) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra || "planThreadId" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief);
            const id = newestWorker();
            await readyIdle(state, id);
            return id;
          },
          /** A plan wave, reported ready and idle: its id. */
          wave: (c: any, wave: number, extra: object = {}) => k.worker(c.chief, { planThreadId: c.planner, wave, ...extra }),
          /** A plan wave as the server stored one before chains shared a branch: a worker of its own on its own branch. */
          legacyWave: async (c: any, wave: number, branch: string) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded oracle fixture", branch }, c.chief);
            const id = newestWorker();
            state.db.prepare("UPDATE managed_threads SET plan_thread_id=?, plan_wave=?, unplanned_reason=NULL WHERE thread_id=?").run(c.planner, wave, id);
            await readyIdle(state, id);
            return id;
          },
          /** The reviewer's Pending line, whole, or a marker when it has none. */
          pending: async (label: string, chief: string, reviewer: string) => {
            const roster = String(await tool(state, "chief_roster", {}, chief));
            emit(label, roster.split("\n").find((line) => line.includes(`(${reviewer}):`)) ?? "(no Pending line)");
          },
          /** Chief starts a review of `target`; its reviewer reports `verdict` with the carried reject_streak `streak` after the report. Emits the alert and Pending line. */
          judge: async (label: string, chief: string, target: object, v: { verdict?: "approve" | "request_changes"; streak?: number; regression?: boolean } = {}) => {
            const verdict = v.verdict ?? "request_changes";
            await tool(state, "chief_review", target, chief);
            const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer" && row.state !== "complete").at(-1)!.threadId;
            if (v.streak && verdict === "request_changes") state.db.prepare(`UPDATE managed_threads SET reject_streak=? WHERE thread_id=?`).run(v.streak - 1, reviewer);
            await report(state, reviewer, {
              state: "ready", result: "The discount is applied twice", verdict, ...(v.regression ? { regression: true } : {}),
              findings: verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "The discount is applied twice", fix: "Apply it once" }],
            });
            emit(`${label}: alert`, state.sent.at(-1).input[0].text);
            await k.pending(`${label}: Pending`, chief, reviewer);
            return reviewer;
          },
          /** The reviewer reports again (a later report re-reads the persisted state): emits the alert it sent, then the Pending line. */
          again: async (label: string, chief: string, reviewer: string, params: object) => {
            await report(state, reviewer, params);
            emit(`${label}: alert`, state.sent.at(-1).input[0].text);
            await k.pending(`${label}: Pending`, chief, reviewer);
          },
          /** Any later write reloads the row cache, so a SQL edit made after a report is read. */
          reload: (chief: string) => k.worker(chief),
          replace: (chief: string, id: string, extra: object = {}) => tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: id, ...extra }, chief),
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };
      const P = (n: number, extra: object = {}) => planWave(n, extra);
      const FIX = { streak: 1 };
      const CONSULT = { streak: 2 };
      const STOP = { streak: 3 };
      /** Two independent branches (waves 1 and 3), tests waived: one plan review covers both. */
      const branches = (k: any) => k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [2, 4]);
      const startBranches = async (k: any, c: any) => [await k.wave(c, 1, { branch: "feature/a" }), await k.wave(c, 3, { branch: "feature/b" })];
      /** Two stacked legacy waves (2 builds on 1), tests waived: one review covers both, reviewed from the tip. */
      const stack = (k: any) => k.mk([P(1), P(2), TEST_WAVE(3)], [3]);
      const stacked = async (k: any, c: any) => { const base = await k.wave(c, 1, { branch: "feature/a" }); return [await k.legacyWave(c, 2, "feature/b"), base]; };
      /** The stack plus one independent branch (wave 4). */
      const stackAndLoose = (k: any) => k.mk([P(1), P(2), TEST_WAVE(3), P(4, { dependsOn: [] }), TEST_WAVE(5, [4])], [3, 5]);
      const stackedAndLoose = async (k: any, c: any) => [...await stacked(k, c), await k.wave(c, 4, { branch: "feature/c" })];
      /** A plan's tester on wave 2 and a worker fixing it on the same wave (a test wave): [tester, fix]. */
      const testerChain = async (k: any) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const impl = await k.wave(c, 1);
        const tester = await k.wave(c, 2, { replaces: impl });
        return { c, tester, fix: () => k.wave(c, 2, { replaces: tester, kind: "worker" }) };
      };
      /** A plan whose wave 1 has a Spec Writer, tests waived: the writer and its worker. */
      const specChain = async (k: any, waived: number[]) => {
        const c = await k.mk([specImpl(), TEST_WAVE(2)], waived);
        const writer = await k.wave(c, 1);
        const worker = await k.wave(c, 1, { replaces: writer, kind: "worker" });
        return { c, writer, worker };
      };
      const unplannedTester = async (k: any, chief: string) => k.worker(chief, { replaces: await k.worker(chief), kind: "tester" });

      // 1. Approve.
      await run("approve: single managed worker", async (k) => {
        const chief = await k.chief();
        await k.judge("approve", chief, { workerThreadId: await k.worker(chief) }, { verdict: "approve" });
      });
      await run("approve: whole plan, one target already complete", async (k) => {
        const c = await branches(k);
        const [a] = await startBranches(k, c);
        const reviewer = await k.judge("approve", c.chief, { workerThreadId: a }, { verdict: "approve" });
        await tool(k.state, "chief_complete", { threadId: a }, c.chief);
        await k.reload(c.chief);
        await k.pending("after completing the first branch: Pending", c.chief, reviewer);
        await k.again("approved again after completing the first branch", c.chief, reviewer, { state: "ready", result: "The discount is applied twice", verdict: "approve", findings: [] });
      });
      await run("approve: unowned branch", async (k) => {
        const chief = await k.chief();
        await k.judge("approve", chief, { branch: "feature/z" }, { verdict: "approve" });
      });
      await run("approve: a carried reject_streak of 3 still approves", async (k) => {
        const chief = await k.chief();
        const reviewer = await k.judge("approve", chief, { workerThreadId: await k.worker(chief) }, { verdict: "approve" });
        k.state.db.prepare(`UPDATE managed_threads SET reject_streak=3 WHERE thread_id=?`).run(reviewer);
        await k.reload(chief);
        await k.pending("approve carrying streak 3: Pending", chief, reviewer);
        // Pending only: an approve report resets reject_streak to 0 before its alert is built, so no accepted report alerts an approve that carries a streak.
      });

      // 2. request_changes at the fix rung.
      await run("fix: single plain worker", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { workerThreadId: await k.worker(chief) }, FIX);
      });
      await run("fix: single worker, regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { workerThreadId: await k.worker(chief) }, { ...FIX, regression: true });
      });
      await run("fix: single unplanned tester", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { workerThreadId: await unplannedTester(k, chief) }, FIX);
      });
      await run("fix: single plan tester", async (k) => {
        const { c, tester } = await testerChain(k);
        await k.judge("fix", c.chief, { workerThreadId: tester }, FIX);
      });
      await run("fix: single worker on a test wave", async (k) => {
        const { c, fix } = await testerChain(k);
        await k.judge("fix", c.chief, { workerThreadId: await fix() }, FIX);
      });
      await run("fix: single worker on a planned spec chain", async (k) => {
        const { c, worker } = await specChain(k, [2]);
        await k.judge("fix", c.chief, { workerThreadId: worker }, FIX);
      });
      await run("fix: single worker on an unplanned chain with a Spec Writer", async (k) => {
        const chief = await k.chief();
        const writer = await k.worker(chief, { kind: "spec-writer" });
        const worker = await k.worker(chief, { replaces: writer, kind: "worker", unplannedReason: "Bounded oracle fixture" });
        await k.judge("fix", chief, { workerThreadId: worker }, FIX);
      });
      await run("fix: tester on a planned spec chain", async (k) => {
        const { c, worker } = await specChain(k, []);
        await k.judge("fix", c.chief, { workerThreadId: await k.wave(c, 2, { replaces: worker }) }, FIX);
      });
      await run("fix: unowned branch, no pull request", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { branch: "feature/z" }, FIX);
      });
      await run("fix: unowned branch with a pull request", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { pullRequest: PR }, FIX);
      });
      await run("fix: unowned branch, regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("fix", chief, { branch: "feature/z" }, { ...FIX, regression: true });
      });
      await run("fix: plan of independent branches", async (k) => {
        const c = await branches(k);
        await k.judge("fix", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, FIX);
      });
      await run("fix: plan of independent branches, regression flagged", async (k) => {
        const c = await branches(k);
        await k.judge("fix", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, { ...FIX, regression: true });
      });
      await run("fix: plan of independent branches, one a tester branch", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [4]);
        const impl = await k.wave(c, 1, { branch: "feature/a" });
        const tester = await k.wave(c, 2, { replaces: impl });
        await k.wave(c, 3, { branch: "feature/b" });
        await k.judge("fix", c.chief, { workerThreadId: tester }, FIX);
      });
      await run("fix: plan of a legacy stack", async (k) => {
        const c = await stack(k);
        await k.judge("fix", c.chief, { workerThreadId: (await stacked(k, c))[0] }, FIX);
      });
      await run("fix: plan of a legacy stack and a loose branch", async (k) => {
        const c = await stackAndLoose(k);
        await k.judge("fix", c.chief, { workerThreadId: (await stackedAndLoose(k, c))[0] }, FIX);
      });
      await run("fix: plan of a legacy stack and a loose branch, regression flagged", async (k) => {
        const c = await stackAndLoose(k);
        await k.judge("fix", c.chief, { workerThreadId: (await stackedAndLoose(k, c))[0] }, { ...FIX, regression: true });
      });

      // 3. The consult rung (carried reject_streak 2).
      await run("consult: plan with stacks", async (k) => {
        const c = await stack(k);
        await k.judge("consult", c.chief, { workerThreadId: (await stacked(k, c))[0] }, CONSULT);
      });
      await run("consult: plan with stacks and a loose branch", async (k) => {
        const c = await stackAndLoose(k);
        await k.judge("consult", c.chief, { workerThreadId: (await stackedAndLoose(k, c))[0] }, CONSULT);
      });
      await run("consult: plan without stacks", async (k) => {
        const c = await branches(k);
        await k.judge("consult", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, CONSULT);
      });
      await run("consult: plan without stacks, one a tester branch", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [4]);
        const impl = await k.wave(c, 1, { branch: "feature/a" });
        const tester = await k.wave(c, 2, { replaces: impl });
        await k.wave(c, 3, { branch: "feature/b" });
        await k.judge("consult", c.chief, { workerThreadId: tester }, CONSULT);
      });
      await run("consult: single managed worker", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { workerThreadId: await k.worker(chief) }, CONSULT);
      });
      await run("consult: single managed worker, regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { workerThreadId: await k.worker(chief) }, { ...CONSULT, regression: true });
      });
      await run("consult: single tested worker", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { workerThreadId: await unplannedTester(k, chief) }, CONSULT);
      });
      await run("consult: single worker on a planned spec chain", async (k) => {
        const { c, worker } = await specChain(k, [2]);
        await k.judge("consult", c.chief, { workerThreadId: worker }, CONSULT);
      });
      await run("consult: unowned branch", async (k) => {
        const chief = await k.chief();
        await k.judge("consult", chief, { branch: "feature/z" }, CONSULT);
      });

      // 4. The stop rung (carried reject_streak 3): the same text for every layout.
      await run("stop: single worker", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { workerThreadId: await k.worker(chief) }, STOP);
      });
      await run("stop: plan", async (k) => {
        const c = await branches(k);
        await k.judge("stop", c.chief, { workerThreadId: (await startBranches(k, c))[0] }, STOP);
      });
      await run("stop: unowned branch", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { branch: "feature/z" }, STOP);
      });
      await run("stop: regression flagged", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { workerThreadId: await k.worker(chief) }, { ...STOP, regression: true });
      });
      await run("stop: a carried reject_streak above 3", async (k) => {
        const chief = await k.chief();
        await k.judge("stop", chief, { workerThreadId: await k.worker(chief) }, { streak: 5 });
      });

      // 5. Null: no Pending line, and the alert falls through.
      await run("null: the reviewer has no verdict", async (k) => {
        const chief = await k.chief();
        const reviewer = await k.judge("reported", chief, { workerThreadId: await k.worker(chief) }, FIX);
        k.state.db.prepare(`UPDATE managed_threads SET verdict=NULL WHERE thread_id=?`).run(reviewer);
        await k.reload(chief);
        await k.pending("verdict cleared: Pending", chief, reviewer);
        // Pending only: no accepted report reaches a ready reviewer with no verdict (checkReport refuses a ready reviewer report without one; a blocked report is routed before the reviewer branch), so its alert is not observable.
      });
      await run("null: the covered worker was re-pointed by replaces", async (k) => {
        const chief = await k.chief();
        const worker = await k.worker(chief);
        const reviewer = await k.judge("reported", chief, { workerThreadId: worker }, FIX);
        await k.replace(chief, worker);
        await k.pending("after the replacement: Pending", chief, reviewer);
        await k.again("reported again after the replacement", chief, reviewer, { state: "ready", result: "The discount is applied twice", ...REQUEST_CHANGES });
      });
      await run("null: a plan target was re-pointed by replaces", async (k) => {
        const c = await branches(k);
        const [a, b] = await startBranches(k, c);
        const reviewer = await k.judge("reported", c.chief, { workerThreadId: a }, FIX);
        await k.wave(c, 1, { replaces: a });
        await k.pending("after replacing branch 1: Pending", c.chief, reviewer);
        await k.wave(c, 3, { replaces: b });
        await k.pending("after replacing branch 3: Pending", c.chief, reviewer);
        await k.again("reported again after replacing branch 3", c.chief, reviewer, { state: "ready", result: "The discount is applied twice", ...REQUEST_CHANGES });
      });
      await run("null: every covered worker is complete", async (k) => {
        const chief = await k.chief();
        const worker = await k.worker(chief);
        await tool(k.state, "chief_review", { workerThreadId: worker }, chief);
        await tool(k.state, "chief_complete", { threadId: worker, testsSkipped: "oracle: no tester", override: "oracle override" }, chief);
        const reviewer = (await status(k.state)).threads.filter((row) => row.role === "reviewer").at(-1)!.threadId;
        await report(k.state, reviewer, { state: "ready", result: "The discount is applied twice", ...REQUEST_CHANGES });
        k.emit("reported after the worker completed: alert", k.state.sent.at(-1).input[0].text);
        await k.pending("reported after the worker completed: Pending", chief, reviewer);
      });
      return blocks.join("\n");
    };
    // <reviewer-advice-oracle-end>

    test("reviewer advice oracle", async () => {
      const head = await reviewerAdviceFixture();
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "reviewer-advice-626c3cd.txt"), "utf8");
      const kept = (text: string) => text.split(/^(?==== )/m).filter((block) => !REPLACED_BY_PARALLEL_LANE(block.slice(4, block.indexOf(" ===\n"))));
      expect(kept(oracle).length).toBeGreaterThan(30);
      expect(kept(head).join("")).toBe(kept(shrinkAlerts(oracle)).join(""));
    }, 180_000);

    // Advice is not permission: the consult advice is the reviewer's instruction, the consult gate on chief_delegate is a separate ledger decision.
    // Regression: a satisfied consult changes the advice sentence, or the advice starts to grant (or withhold) the replacement.
    test("reviewer advice is not permission: the consult sentence stays after the consult, and chief_delegate still gates on the consult", async () => {
      const state = await setup();
      execFileMock.mockReset();
      execFileMock.mockImplementation(async () => { throw new Error("unexpected CLI"); });
      const chief = (await start(state)).threadId;
      const worker = async (extra: object = {}): Promise<string> => {
        await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief);
        const id = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        await readyIdle(state, id);
        return id;
      };
      const pendingLine = async (reviewer: string) => String(await tool(state, "chief_roster", {}, chief)).split("\n").find((line) => line.includes(`(${reviewer}):`));
      const first = await worker();
      await reviewed(state, chief, first, "request_changes");
      const second = await worker({ replaces: first });
      await reviewed(state, chief, second, "request_changes", { retestSkipped: "the rerun is not what this test pins" });
      const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer").at(-1)!.threadId;
      const advice = await pendingLine(reviewer);
      expect(advice).toContain(`The reviewer still requires changes after 2 consecutive rounds. Call chief_consult (workerThreadId: ${second}) now, before any further delegation`);
      const gate = `The reviewer has requested changes 2 times in a row on ${second}. Call chief_consult (workerThreadId: ${second}) and wait for it to send its advice (a ready or blocked report; a status-only, stopped or completed-unreported consult does not count) before delegating the one more round.`;
      await expect(tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: second }, chief)).rejects.toThrow(gate);

      await tool(state, "chief_consult", { title: "Advice", mission: "Diagnose", workerThreadId: second }, chief);
      const advisor = (await status(state)).threads.filter((row) => row.role === "advisor" && row.workerThreadId === second).at(-1)!.threadId;
      await report(state, advisor, { state: "ready", result: "Try X" });
      const created = (state.db.prepare(`SELECT created_at FROM managed_threads WHERE thread_id=?`).get(second) as { created_at: number }).created_at;
      state.db.prepare(`UPDATE reviewer_verdicts SET at=?`).run(created + 1_000);
      state.db.prepare(`UPDATE managed_threads SET created_at=? WHERE thread_id=?`).run(created + 2_000, advisor);
      expect(await pendingLine(reviewer)).toBe(advice);
      await expect(tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: second }, chief)).resolves.toEqual(expect.any(String));
    }, 120_000);
  });
});
