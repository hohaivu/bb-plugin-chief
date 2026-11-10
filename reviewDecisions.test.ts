import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { plan, planWave, readyIdle, report, reviewed, rowOf, setLive, tool } from "./test/testerHelpers";
import { HEAD_SHA, TEST_WAVE, approvePlan, chiefReview, disposeAll, execFileMock, legacyWave, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  describe("Spec Writer role", () => {
    // ---- Review decisions: characterization on base 4b5ad00 (tests first, before reviewLedger takes the decisions) ----
    // Contract: for each case below, chief_delegate (replaces:), the advisor's and reviewer's alerts, chief_complete,
    // chief_complete with skipReview and chief_review give the outcome saved in test/fixtures/review-decisions-4b5ad00.txt:
    // the refusal text, or the reply, or the alert Chief received. The real handlers run; nothing is observed through a
    // production seam; the storage root is normalized, and the forge is execFileMock (gh pr view / gh pr ready).
    // Timestamps that the consult gate compares are set in SQL, so no case depends on the clock.
    // Regression: moving the replace, in-flight and head-approved decisions changes a refusal sentence or the order of the
    // checks, a rung line, a forge call count, a cleanup line, or which review chief_review reuses.
    // <review-decisions-oracle-begin>
    const reviewDecisionsFixture = async () => {
      const blocks: string[] = [];
      const PR = "https://github.com/acme/shop/pull/8";
      const NO_TESTER = { testsSkipped: "oracle: no tester" };
      /** A review after a fix owes a tester rerun; the oracle waives it so every scenario still reaches the decision it pins. */
      const reviewedOrWaived = (state: any, chief: string, id: string, verdict: "approve" | "request_changes") =>
        reviewed(state, chief, id, verdict).catch((error: Error) => {
          if (!error.message.includes("rerun the tests")) throw error;
          return reviewed(state, chief, id, verdict, { retestSkipped: "oracle: no tester" });
        });
      const run = async (name: string, body: (k: any) => Promise<void>) => {
        const state = await setup();
        await state.harness.behavior.setSettings({ cleanupApproved: true });
        const lines: string[] = [];
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${text.replaceAll(state.storageRoot, "<storage>")}`);
        const forge = { sha: HEAD_SHA, unreadable: false };
        execFileMock.mockReset();
        execFileMock.mockImplementation(async (file: string, args: string[]) => {
          if (file === "gh" && args[0] === "pr" && args[1] === "view") {
            if (forge.unreadable) throw new Error("gh: forge unreachable");
            return { stdout: JSON.stringify({ headRefName: "feature/x", headRefOid: forge.sha, baseRefName: "main" }), stderr: "" };
          }
          if (file === "gh" && args[0] === "pr" && args[1] === "ready") return { stdout: "", stderr: "" };
          throw new Error(`unexpected CLI ${file}`);
        });
        const prViews = () => execFileMock.mock.calls.filter(([file, args]) => file === "gh" && args[0] === "pr" && args[1] === "view").length;
        const newestWorker = () => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        const k = {
          state, forge, emit,
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
          /** Delegates a plan wave, reports ready, goes idle: its id. */
          wave: (c: any, wave: number, extra: object = {}) => k.worker(c.chief, { planThreadId: c.planner, wave, ...extra }),
          /** A plan wave as the server stored one before chains shared a branch: a worker of its own on its own branch, which chief_delegate no longer builds (see legacyWave). */
          legacyWave: async (c: any, wave: number, branch: string) => {
            await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", unplannedReason: "Bounded oracle fixture", branch }, c.chief);
            const id = newestWorker();
            state.db.prepare("UPDATE managed_threads SET plan_thread_id=?, plan_wave=?, unplanned_reason=NULL WHERE thread_id=?").run(c.planner, wave, id);
            await readyIdle(state, id);
            return id;
          },
          replace: (chief: string, id: string, extra: object = {}) => tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", replaces: id, ...extra }, chief),
          /** Runs a call: its reply or its refusal, and how many threads it launched. */
          attempt: async (label: string, call: () => Promise<unknown>) => {
            const before = state.spawned.length;
            const out = await call().then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            emit(label, `${out}\nlaunched: ${state.spawned.length - before}`);
          },
          /** A consult on the worker; its advisor reports `advice` (ready) or only a status (active). */
          consult: async (chief: string, id: string, how: "advice" | "status" = "advice") => {
            await tool(state, "chief_consult", { title: "Advice", mission: "Diagnose", workerThreadId: id }, chief);
            const advisor = (await status(state)).threads.filter((row) => row.role === "advisor" && row.workerThreadId === id).at(-1)!.threadId;
            await report(state, advisor, how === "advice" ? { state: "ready", result: "Try X" } : { state: "active", summary: "Still reading" });
            return advisor;
          },
          /** Pins the times the consult gate compares, as offsets from the prior worker's creation (the server reads that from its row cache, which a SQL edit would not reach). */
          stamp: (prior: string, times: { verdicts: number; advisor: [string, number] }) => {
            const created = (state.db.prepare(`SELECT created_at FROM managed_threads WHERE thread_id=?`).get(prior) as { created_at: number }).created_at;
            state.db.prepare(`UPDATE reviewer_verdicts SET at=?`).run(created + times.verdicts);
            state.db.prepare(`UPDATE managed_threads SET created_at=? WHERE thread_id=?`).run(created + times.advisor[1], times.advisor[0]);
          },
          /** Reviews and rejects `n` times, handing each rejected worker to a fresh one (a consult first from the second): the last worker, ready and idle, and the last alert. */
          rejected: async (chief: string, n: number, first?: string, next: object = {}) => {
            let id = first ?? await k.worker(chief);
            let alert = "";
            for (let round = 1; round <= n; round++) {
              alert = await reviewedOrWaived(state, chief, id, "request_changes");
              if (round === n) break;
              if (round >= 2) await k.consult(chief, id);
              id = await k.worker(chief, { replaces: id, ...next });
            }
            return { id, alert };
          },
          /** The same rounds over several ready workers reviewed together (the first id is reviewed); each alert is emitted. `fix` hands every worker to a fresh one. */
          rounds: async (label: string, chief: string, ids: string[], n: number, fix: (ids: string[]) => Promise<string[]>) => {
            let current = ids;
            for (let round = 1; round <= n; round++) {
              emit(`${label}: streak ${round}`, await reviewedOrWaived(state, chief, current[0]!, "request_changes"));
              if (round === n) break;
              if (round >= 2) await k.consult(chief, current[0]!);
              current = await fix(current);
            }
            return current;
          },
          /** A chief_complete attempt: its reply or refusal, the worker's state after it, and the gh pr view calls it made. */
          completing: async (label: string, chief: string, id: string, extra: object = {}) => {
            const before = prViews();
            const out = await tool(state, "chief_complete", { threadId: id, ...extra }, chief).then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            emit(label, `${out}\nstate: ${rowOf(state, id).state}\ngh pr view calls: ${prViews() - before}`);
          },
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };
      const P = (n: number, extra: object = {}) => planWave(n, extra);
      /** Two independent branches (waves 1 and 3), tests waived: one plan review covers both. */
      const branches = (k: any) => k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])], [2, 4]);
      /** One worker per branch, each on its own task branch (a plan review needs a head or a branch for every target). */
      const startBranches = async (k: any, c: any) => [await k.wave(c, 1, { branch: "feature/a" }), await k.wave(c, 3, { branch: "feature/b" })];
      /** Replaces every branch worker with a fresh one of the same wave. */
      const fixBranches = (k: any, c: any) => async ([a, b]: string[]) => [await k.wave(c, 1, { replaces: a }), await k.wave(c, 3, { replaces: b })];
      /** Two stacked waves (2 builds on 1), tests waived: one review covers both, reviewed from the tip. */
      const stack = (k: any) => k.mk([P(1), P(2), TEST_WAVE(3)], [3]);
      const stacked = async (k: any, c: any) => { const base = await k.wave(c, 1, { branch: "feature/a" }); return [await k.legacyWave(c, 2, "feature/b"), base]; };
      const fixStack = (k: any, c: any) => async ([tip, base]: string[]) => { const fresh = await k.wave(c, 1, { replaces: base }); return [await k.wave(c, 2, { replaces: tip }), fresh]; };

      // 1. Replacement: the ladder.
      for (const streak of [0, 1]) {
        await run(`replacement at streak ${streak}`, async (k) => {
          const chief = await k.chief();
          const { id } = streak ? await k.rejected(chief, streak) : { id: await k.worker(chief) };
          await k.attempt(`replace at streak ${streak}`, () => k.replace(chief, id));
        });
      }
      await run("replacement at streak 2 with no consult", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult after the latest rejection", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        const advisor = await k.consult(chief, id);
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, 2_000] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult before the latest rejection", async (k) => {
        const chief = await k.chief();
        const first = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, first, "request_changes");
        const advisor = await k.consult(chief, first);
        const { id } = await k.rejected(chief, 1, await k.worker(chief, { replaces: first }));
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, 500] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: status-only consult", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        const advisor = await k.consult(chief, id, "status");
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, 2_000] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult created before the prior worker", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        const advisor = await k.consult(chief, id);
        k.stamp(id, { verdicts: -2_000, advisor: [advisor, -1_000] });
        await k.attempt("replace", () => k.replace(chief, id));
      });
      await run("replacement at streak 2: consult on another branch of the same plan review", async (k) => {
        const c = await branches(k);
        const [a, b] = await k.rounds("rounds", c.chief, await startBranches(k, c), 2, fixBranches(k, c));
        const advisor = await k.consult(c.chief, b);
        k.stamp(a, { verdicts: 1_000, advisor: [advisor, 2_000] });
        await k.attempt("replace branch 1's worker on the consult of branch 3's worker", () => k.replace(c.chief, a));
      });
      await run("replacement at streak 3", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 3);
        await k.attempt("replace without userApprovedRound", () => k.replace(chief, id));
        await k.attempt("replace with userApprovedRound: false", () => k.replace(chief, id, { userApprovedRound: false }));
      });
      await run("replacement at streak 3 with userApprovedRound, no consult after the rejection", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 3);
        const advisor = (await status(k.state)).threads.filter((row) => row.role === "advisor").at(-1)!.threadId;
        k.stamp(id, { verdicts: 1_000, advisor: [advisor, -5_000] });
        await k.attempt("replace with userApprovedRound", () => k.replace(chief, id, { userApprovedRound: true }));
      });
      await run("replacement: an approve between rejections resets the streak", async (k) => {
        const chief = await k.chief();
        const first = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, first, "request_changes");
        const second = await k.worker(chief, { replaces: first });
        await reviewedOrWaived(k.state, chief, second, "approve");
        const { id } = await k.rejected(chief, 2, await k.worker(chief, { replaces: second }));
        await k.attempt("replace after reject, approve, reject, reject", () => k.replace(chief, id));
      });

      // 2. Order at the stop rung (and the consult rung): the ladder against the other refusals.
      await run("order: stop rung, prior busy", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 3);
        setLive(k.state, id, "active");
        await k.attempt("replace a busy prior at the stop rung", () => k.replace(chief, id));
      });
      await run("order: consult rung, prior busy", async (k) => {
        const chief = await k.chief();
        const { id } = await k.rejected(chief, 2);
        setLive(k.state, id, "active");
        await k.attempt("replace a busy prior at the consult rung", () => k.replace(chief, id));
      });
      await run("order: stop rung, tester prior with no kind", async (k) => {
        const chief = await k.chief();
        const tester = await k.worker(chief, { replaces: await k.worker(chief), kind: "tester" });
        const { id } = await k.rejected(chief, 3, tester, { kind: "tester" });
        await k.attempt("replace a tester without kind at the stop rung", () => k.replace(chief, id));
        await k.attempt("replace a tester without kind at the stop rung, user approved", () => k.replace(chief, id, { userApprovedRound: true }));
      });
      await run("order: stop rung, planner refusal", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)], [2]);
        const { id } = await k.rejected(c.chief, 3, await k.wave(c, 1), { planThreadId: c.planner, wave: 1 });
        await k.attempt("replace on a wave out of range at the stop rung", () => k.replace(c.chief, id, { planThreadId: c.planner, wave: 5 }));
        await k.attempt("replace on a wave out of range at the stop rung, user approved", () => k.replace(c.chief, id, { planThreadId: c.planner, wave: 5, userApprovedRound: true }));
      });

      // 3. nextAction: the advisor line.
      for (const streak of [1, 2, 3]) {
        await run(`advisor line at streak ${streak}`, async (k) => {
          const chief = await k.chief();
          const { id } = await k.rejected(chief, streak);
          await k.consult(chief, id);
          k.emit(`the advisor's alert at streak ${streak}`, k.state.sent.at(-1).input[0].text);
        });
      }

      // 4. nextAction: the reviewer's fix, consult and stop lines.
      await run("reviewer lines: plain", async (k) => {
        const chief = await k.chief();
        await k.rounds("plain", chief, [await k.worker(chief)], 3, async ([id]: string[]) => [await k.worker(chief, { replaces: id })]);
      });
      await run("reviewer lines: a plan", async (k) => {
        const c = await branches(k);
        await k.rounds("plan", c.chief, await startBranches(k, c), 3, fixBranches(k, c));
      });
      await run("reviewer lines: stacks", async (k) => {
        const c = await stack(k);
        await k.rounds("stacks", c.chief, await stacked(k, c), 3, fixStack(k, c));
      });

      // 5. chief_complete: what covers the worker.
      await run("complete: no verdict", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await k.completing("no review", chief, id, NO_TESTER);
      });
      await run("complete: request_changes", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewedOrWaived(k.state, chief, id, "request_changes");
        await k.completing("newest review is request_changes", chief, id, NO_TESTER);
      });
      await run("complete: an approve whose head matches the PR head", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewedOrWaived(k.state, chief, id, "approve");
        await k.completing("approve at the PR head", chief, id, NO_TESTER);
      });
      await run("complete: an approve whose head does not match", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewedOrWaived(k.state, chief, id, "approve");
        k.forge.sha = "b".repeat(40);
        await k.completing("approve, the PR moved on", chief, id, NO_TESTER);
      });
      await run("complete: an uppercase recorded head_sha", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewedOrWaived(k.state, chief, id, "approve");
        k.state.db.prepare(`UPDATE reviewer_verdicts SET head_sha=upper(head_sha)`).run();
        await k.completing("approve recorded in uppercase", chief, id, NO_TESTER);
      });
      await run("complete: an unreadable PR head", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await reviewedOrWaived(k.state, chief, id, "approve");
        k.forge.unreadable = true;
        await k.completing("approve, gh fails", chief, id, NO_TESTER);
      });
      await run("complete: an approve with no PR", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, id, "approve");
        await k.completing("approve, report unchanged", chief, id, NO_TESTER);
      });
      await run("complete: an approve with no PR, the report moved on", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, id, "approve");
        await readyIdle(k.state, id, "Done again");
        await k.completing("approve, newer report", chief, id, NO_TESTER);
      });
      for (const [label, extra] of [["no PR", {}], ["a PR", { prUrl: PR }]] as const) {
        await run(`complete: the newest approve was recorded on an older chain member, ${label}`, async (k) => {
          const chief = await k.chief();
          const first = await k.worker(chief, extra);
          await reviewedOrWaived(k.state, chief, first, "approve");
          const second = await k.worker(chief, { replaces: first });
          await k.completing(`the replacement, never reviewed (${label})`, chief, second, NO_TESTER);
        });
      }
      await run("complete: override with a reason", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief, { prUrl: PR });
        await k.completing("override, no review", chief, id, { ...NO_TESTER, override: "oracle override" });
      });
      await run("complete: a design wave", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)], [3]);
        const designer = await k.wave(c, 1);
        await k.completing("design wave, no owner approval", c.chief, designer);
        await tool(k.state, "chief_owner_approval", { workerThreadId: designer, approval: "Looks right, ship it" }, c.chief);
        await k.completing("design wave, owner approved", c.chief, designer);
      });
      await run("complete: cleanup line, queued", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, id, "approve");
        await k.completing("approved, cleanup on", chief, id, NO_TESTER);
      });
      await run("complete: cleanup line, unapproved", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await k.completing("skipReview", chief, id, { ...NO_TESTER, skipReview: "oracle skip" });
      });
      await run("complete: cleanup line, off", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, id, "approve");
        await k.state.harness.behavior.setSettings({ cleanupApproved: false });
        await k.completing("approved, cleanup off", chief, id, NO_TESTER);
      });

      // 6. skipReview against an open review.
      await run("skipReview: a busy open review", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await tool(k.state, "chief_review", { workerThreadId: id }, chief);
        await k.completing("skipReview while the reviewer runs", chief, id, { ...NO_TESTER, skipReview: "oracle skip" });
      });
      await run("skipReview: a busy open review on the replaced chain's head", async (k) => {
        const chief = await k.chief();
        const first = await k.worker(chief);
        await tool(k.state, "chief_review", { workerThreadId: first }, chief);
        const second = await k.worker(chief, { replaces: first });
        await k.completing("skipReview of the replacement while the re-pointed reviewer runs", chief, second, { ...NO_TESTER, skipReview: "oracle skip" });
      });
      await run("skipReview: an idle open review", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, id, "request_changes");
        await k.completing("skipReview after the reviewer reported", chief, id, { ...NO_TESTER, skipReview: "oracle skip" });
      });

      // 7. chief_review: an in-flight review is reused.
      const reviewing = async (k: any, label: string, chief: string, id: string) => {
        const before = k.state.spawned.length;
        const review = await chiefReview(k.state, chief, { workerThreadId: id });
        k.emit(label, `created: ${review.created}\nthreadId: ${review.threadId}\ntitle: ${review.title}\nlaunched: ${k.state.spawned.length - before}${review.created ? "" : `\n${review.text}`}`);
        return review;
      };
      await run("chief_review: an in-flight review", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewing(k, "first call", chief, id);
        await reviewing(k, "second call, the reviewer still running", chief, id);
      });
      await run("chief_review: an in-flight plan review", async (k) => {
        const c = await branches(k);
        const [a, b] = await startBranches(k, c);
        await reviewing(k, "first call, from branch 1", c.chief, a);
        await reviewing(k, "second call, from branch 1", c.chief, a);
        await reviewing(k, "third call, from branch 3", c.chief, b);
      });
      await run("chief_review: an idle open review is superseded", async (k) => {
        const chief = await k.chief();
        const id = await k.worker(chief);
        await reviewedOrWaived(k.state, chief, id, "request_changes");
        await reviewing(k, "call after the reviewer reported", chief, id);
      });
      return blocks.join("\n");
    };
    // <review-decisions-oracle-end>

    // The "a design wave" block has one implementation wave, so it spawns no advisor thread: its thread ids are one lower than on base 4b5ad00 (1 line of the fixture); nothing else changed.
    test("review decisions oracle", async () => {
      const head = await reviewDecisionsFixture();
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "review-decisions-4b5ad00.txt"), "utf8");
      expect(head).toBe(oracle);
    }, 120_000);

    // Contract: chief_complete's skipReview refusal names the first busy review down the worker's own task chain, own
    // review first, as on base 4b5ad00; chief_review still picks newest first. Regression: sorting the chain's open reviews
    // by age names the newer review of the replaced worker. Unplanned W1 is replaced by W2, then R2 starts on W2 and a
    // newer R1 on W1 (an unplanned review of a replaced worker is allowed), so only a real chain scan names R2.
    test("skipReview on a replacement names its own busy review, not a newer one on the replaced worker", async () => {
      const state = await setup();
      execFileMock.mockReset();
      const chief = (await start(state)).threadId;
      const worker = async (extra: object = {}) => {
        await tool(state, "chief_delegate", { title: "Fix totals", mission: "Do it.", ...("replaces" in extra ? {} : { unplannedReason: "Bounded chain fixture" }), ...extra }, chief);
        const id = (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
        await readyIdle(state, id);
        return id;
      };
      const w1 = await worker();
      const w2 = await worker({ replaces: w1 });
      const r2 = (await chiefReview(state, chief, { workerThreadId: w2 })).threadId;
      const r1 = (await chiefReview(state, chief, { workerThreadId: w1 })).threadId;
      expect(r1).not.toBe(r2);
      // Pin R1 as the newer review in SQL, so the order never depends on the clock.
      state.db.prepare(`UPDATE managed_threads SET created_at=(SELECT created_at FROM managed_threads WHERE thread_id=?)+1000 WHERE thread_id=?`).run(r2, r1);
      const refusal = await tool(state, "chief_complete", { threadId: w2, skipReview: "chain order", testsSkipped: "chain order" }, chief).then(() => "completed", (error: Error) => error.message);
      expect(refusal).toBe(`Refusing to skip the review of ${w2}: review ${r2} is still running; wait for its verdict.`);
    }, 120_000);
  });
});
