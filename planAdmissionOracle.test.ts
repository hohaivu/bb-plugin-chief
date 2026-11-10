import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseImpl, skipSpecs, specImpl } from "./test/specWriterHelpers";
import { READY, type State, ctxOf, delegateWave, plan, planWave, planWaves, readyIdle, report, reviewed, setLive, tool, workerOn } from "./test/testerHelpers";
import { TEST_WAVE, approvePlan, delegate, disposeAll, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { acceptDesignRefusal, acceptOwnership, dropDocsLines, dropSkippedNote } from "./test/docsOwnership";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  describe("Spec Writer role", () => {
    // ---- Plan admission and waivers: characterization on base c8a0d76 (tests first, before planLifecycle.ts) ----
    // Contract: for each case below, chief_delegate, chief_skip_tests and chief_skip_specs give the outcome saved in
    // test/fixtures/plan-admission-c8a0d76.txt: the refusal text, or the accepted kind plus the prompt the launched thread
    // received. The real handlers run; nothing is observed through a production seam; only the storage root is normalized.
    // Regression: a refactor of admission or the waiver predicates changes a refusal sentence or its order, a worker prompt
    // field, an idempotent repeat, or tightens a loose path (a terminal prior, a review after a worker fix on a test wave).
    // Plan chains (this branch) changed exactly these outcomes of the base snapshot, nothing else: wave 2 of a legacy plan, a second
    // worker on a started head, and a replaces: across chains now refuse with the chain sentences (a later wave continues its chain's
    // worker; the design-owner-approval refusal of a wave with no replaces is pre-empted by the same rule and still holds on replaces:);
    // the independent-wave brief line names the chain. Every other block is the base's bytes.
    // <plan-admission-oracle-begin>
    // The Spec Writer runs beside its worker (plan thr_y72683k2qk): these recorded blocks drive the old writer-first model (a default first
    // delegation is the Spec Writer, a Spec Writer owes the next wave, chief_skip_specs refuses once any row exists), so their base outcomes
    // are no longer the contract. Their parallel-lane successors are specWriterRouting.test.ts, planLifecycle.test.ts and specWriterReview.test.ts.
    // The legacy blocks below stay byte for byte, apart from the prompt lines normalized by `asBase`.
    const REPLACED_BY_PARALLEL_LANE = (name: string) =>
      name.startsWith("spec flow:") || name.startsWith("skip_specs:") || name === "explicitKind on a Spec Writer";
    /** The authorized text changes, undone: wave 2's prompt lines (local sync before reading, the no-autostash rebase, a tester's merge-base check)
     * and wave 1's test-wave refusal, which names the chain's owner (plan thr_y72683k2qk, `chainOwner`) where the base wrote a placeholder. */
    const asBase = (text: string) => text
      .replace(/(wave: 3, replaces: )thr_4(, kind: tester\)\.\n--- wave 2 replaces wave 1's worker)/, "$1<wave 2's latest worker>$2")
      .replace(/^Before you read any file, sync this checkout with .*\n/gm, "")
      .replace(/^- Before you derive tests, for each Spec Writer listed above .*\n/gm, "")
      .replace(/`git fetch origin ([^`\s]+)` then `git rebase --no-autostash origin\/\1` on a clean tree and push again/g, "`git fetch origin $1`, rebase onto origin/$1 and push again");
    const admissionFixture = async () => {
      const blocks: string[] = [];
      const newestId = (state: State) => (state.db.prepare(`SELECT thread_id FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any).thread_id as string;
      const run = async (name: string, body: (k: any) => Promise<void>) => {
        if (REPLACED_BY_PARALLEL_LANE(name)) return;
        const state = await setup();
        const lines: string[] = [];
        const emit = (label: string, text: string) => lines.push(`--- ${label}\n${text.replaceAll(state.storageRoot, "<storage>")}`);
        const newest = () => state.db.prepare(`SELECT * FROM managed_threads WHERE role='worker' ORDER BY rowid DESC`).get() as any;
        const k = {
          state,
          /** Chief plus a planner holding `waves`; approved unless it has at most one implementation wave. */
          mk: async (waves: object[], approve = waves.filter((entry: any) => !entry.test && !entry.design).length > 1) => {
            const chief = (await start(state)).threadId;
            const planner = (await plan(state, chief, waves)).threadId;
            if (approve) await approvePlan(state, chief, planner);
            return { chief, planner };
          },
          go: (c: any, n: number, extra: object = {}) => delegateWave(state, c.chief, c.planner, n, extra),
          /** Delegate (must be admitted), report ready, go idle: the new row's id. */
          done: async (c: any, n: number, extra: object = {}) => {
            await delegateWave(state, c.chief, c.planner, n, extra);
            const id = workerOn(state, c.planner, n).thread_id as string;
            await readyIdle(state, id);
            return id;
          },
          /** Delegate (must be admitted), then report blocked and go idle. */
          stuck: async (c: any, n: number, extra: object = {}) => {
            await delegateWave(state, c.chief, c.planner, n, extra);
            const id = workerOn(state, c.planner, n).thread_id as string;
            await report(state, id, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
            setLive(state, id, "idle");
            return id;
          },
          /** Unplanned delegation; `replaces` carries the plan or the lack of one. */
          free: (chief: string, extra: object = {}) =>
            tool(state, "chief_delegate", { title: "Free", mission: "Do it.", ...("replaces" in extra ? {} : { unplannedReason: "Bounded oracle fixture" }), ...extra }, chief),
          /** A chief_delegate attempt: the refusal text, or the accepted kind and the launched prompt. */
          delegating: async (label: string, call: () => Promise<unknown>) => {
            const before = state.spawned.length;
            const refusal = await call().then(() => null, (error: Error) => error.message);
            const launched = state.spawned.length - before;
            emit(label, refusal !== null
              ? `refused: ${refusal}${launched ? `\n(launched ${launched} thread(s) anyway)` : ""}`
              : `accepted ${newest().kind ?? "worker"}, launched ${launched}\n${state.spawned.at(-1).prompt}`);
          },
          /** Any other tool attempt: its reply or refusal, then the plan's waivers and worker rows. */
          acting: async (label: string, call: () => Promise<unknown>, planThreadId?: string) => {
            const out = await call().then((text) => `reply: ${text}`, (error: Error) => `refused: ${error.message}`);
            const after = planThreadId === undefined ? "" : `\nwaivers: ${JSON.stringify(JSON.parse(planWaves(state, planThreadId)).map((entry: any) => ({ testsSkipped: entry.testsSkipped, specsSkipped: entry.specsSkipped })))}`
              + `\nworkers: ${JSON.stringify(state.db.prepare(`SELECT thread_id, plan_wave, kind, state FROM managed_threads WHERE role='worker' AND plan_thread_id=? ORDER BY rowid`).all(planThreadId))}`;
            emit(label, `${out}${after}`);
          },
          skipTests: (c: any, n: number) => tool(state, "chief_skip_tests", { planThreadId: c.planner, wave: n, reason: "oracle reason" }, c.chief),
          skipSpecs: (c: any, n: number) => tool(state, "chief_skip_specs", { planThreadId: c.planner, wave: n, reason: "oracle reason" }, c.chief),
          /** Rewrites the planner's stored waves as a plan from before test waves: no test fields. */
          strip: async (c: any, worker: string) => {
            const waves = JSON.parse(planWaves(state, c.planner)).map(({ test, ...rest }: any) => rest);
            state.db.prepare(`UPDATE managed_threads SET plan_waves=? WHERE thread_id=?`).run(JSON.stringify(waves), c.planner);
            await report(state, worker, { state: "ready", result: `${READY} (re-reported)` });
          },
        };
        try { await body(k); } catch (error) { (error as Error).message = `[${name}] ${(error as Error).message}`; throw error; }
        blocks.push(`=== ${name} ===\n${lines.join("\n")}\n`);
      };
      const P = (n: number, extra: object = {}) => planWave(n, extra);

      // 1. Legacy plans (no dependsOn: the previous wave is the parent) and independent heads (dependsOn: []).
      await run("legacy plan with no dependsOn", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3)]);
        const w1 = await k.done(c, 1);
        await k.delegating("wave 3 tester replaces wave 1's worker, not its parent", () => k.go(c, 3, { replaces: w1, kind: "tester" }));
        await k.delegating("wave 2 replaces wave 1's worker", () => k.go(c, 2, { replaces: w1 }));
        const w2 = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, w2);
        await k.delegating("wave 3 tester replaces wave 2's worker", () => k.go(c, 3, { replaces: w2 }));
      });
      await run("legacy plan, wave 2 with no replaces", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3)]);
        await k.done(c, 1);
        await k.delegating("wave 2 with no replaces", () => k.go(c, 2));
      });
      await run("independent heads", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), P(3, { dependsOn: [] }), TEST_WAVE(4, [3])]);
        const w1 = await k.done(c, 1);
        await k.delegating("wave 3, an independent head, with no replaces", () => k.go(c, 3));
        const w3 = workerOn(k.state, c.planner, 3).thread_id;
        await readyIdle(k.state, w3);
        await k.delegating("wave 4 tester replaces wave 1's worker, not its parent", () => k.go(c, 4, { replaces: w1, kind: "tester" }));
        await k.delegating("wave 4 tester replaces wave 3's worker", () => k.go(c, 4, { replaces: w3 }));
        await k.delegating("wave 3 replaces wave 1's worker", () => k.go(c, 3, { replaces: w1 }));
      });

      // 2. Wave range, and an absent (waived) test wave.
      await run("wave range (0 and 9 fail the tool schema first) and an absent test wave", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.delegating("wave 5 of 2", () => k.go(c, 5));
        await k.delegating("wave omitted", () => k.go(c, undefined as any));
        const w1 = await k.done(c, 1);
        await k.acting("skip_tests on the undelegated wave 2", () => k.skipTests(c, 2), c.planner);
        await k.delegating("wave 2 waived before delegation", () => k.go(c, 2, { replaces: w1 }));
        await k.delegating("wave 2 waived before delegation, kind tester with a branch", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
      });

      // 3. explicitKind, and its order against the other faults.
      await run("explicitKind", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.delegating("prior tester, kind omitted", () => k.go(c, 2, { replaces: tester }));
        await k.delegating("prior tester, kind omitted, unknown planThreadId", () => k.go({ ...c, planner: "thr_unknown" }, 1, { replaces: tester }));
        await k.delegating("prior worker, kind omitted, unknown planThreadId", () => k.go({ ...c, planner: "thr_unknown" }, 1, { replaces: w1 }));
        const unreviewed = (await plan(k.state, c.chief, [P(1), P(2), TEST_WAVE(3)])).threadId;
        await k.delegating("prior tester, kind omitted, unreviewed planner", () => k.go({ ...c, planner: unreviewed }, 1, { replaces: tester }));
        await k.delegating("prior worker, kind worker, unreviewed planner", () => k.go({ ...c, planner: unreviewed }, 1, { replaces: w1, kind: "worker" }));
        await k.delegating("no prior, unreviewed planner, wave 5 of 3", () => k.go({ ...c, planner: unreviewed }, 5));
        const other = await start(k.state, "proj_2");
        await k.state.harness.behavior.runCli(["plan", "--title", "Foreign", "--mission", "Propose"], ctxOf(k.state, other.threadId));
        const foreign = (await status(k.state)).threads.filter((row) => row.role === "planner" && row.chiefThreadId === other.threadId).at(-1)!.threadId;
        await k.delegating("prior tester, kind omitted, another Chief's planner", () => k.go({ ...c, planner: foreign }, 1, { replaces: tester }));
        await k.delegating("prior worker, kind worker, another Chief's planner", () => k.go({ ...c, planner: foreign }, 1, { replaces: w1, kind: "worker" }));
        await k.delegating("prior tester, kind omitted, another Chief", () => tool(k.state, "chief_delegate", { title: "x", mission: "y", replaces: tester }, other.threadId));
      });
      await run("explicitKind on a Spec Writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.delegating("prior Spec Writer, kind omitted", () => k.go(c, 1, { replaces: writer }));
        await k.delegating("prior Spec Writer, kind omitted, unknown planThreadId", () => k.go({ ...c, planner: "thr_unknown" }, 1, { replaces: writer }));
      });

      // 4. Spec flow.
      await run("spec flow: first delegation (c)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.delegating("kind worker", () => k.go(c, 1, { kind: "worker" }));
        await k.delegating("kind designer", () => k.go(c, 1, { kind: "designer" }));
        await k.delegating("kind tester", () => k.go(c, 1, { kind: "tester" }));
        await k.delegating("kind tester with a branch", () => k.go(c, 1, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("wave 2 before the writer", () => k.go(c, 2));
        await k.delegating("kind omitted", () => k.go(c, 1));
      });
      await run("spec flow: first delegation with kind spec-writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.delegating("kind spec-writer", () => k.go(c, 1, { kind: "spec-writer" }));
      });
      await run("spec flow: the writer is ready (a2)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.delegating("no replaces", () => k.go(c, 1));
        await k.delegating("replaces the writer, kind tester", () => k.go(c, 2, { replaces: writer, kind: "tester" }));
        await k.delegating("replaces the writer, kind omitted on wave 1", () => k.go(c, 1, { replaces: writer }));
        await k.delegating("kind designer", () => k.go(c, 1, { replaces: writer, kind: "designer" }));
        await k.delegating("repair: kind spec-writer", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
        await k.delegating("hand-off: kind worker", () => k.go(c, 1, { replaces: writer, kind: "worker" }));
      });
      await run("spec flow: the writer is blocked (a2, a)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.stuck(c, 1);
        await k.delegating("kind worker", () => k.go(c, 1, { replaces: writer, kind: "worker" }));
        await k.delegating("kind designer", () => k.go(c, 1, { replaces: writer, kind: "designer" }));
        await k.delegating("no replaces", () => k.go(c, 1));
        await k.delegating("wave 2 tester replaces the blocked writer", () => k.go(c, 2, { replaces: writer, kind: "tester" }));
        await k.delegating("repair: kind spec-writer", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
      });
      await run("spec flow: a fresh plan takes over a blocked Spec Writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.stuck(c, 1);
        const fresh = (await plan(k.state, c.chief, [specImpl(1), TEST_WAVE(2)])).threadId;
        const next = { ...c, planner: fresh };
        await k.delegating("fresh wave 1, kind worker", () => k.go(next, 1, { replaces: writer, kind: "worker" }));
        await k.delegating("fresh wave 2, kind tester", () => k.go(next, 2, { replaces: writer, kind: "tester" }));
        await k.delegating("fresh wave 1, kind spec-writer", () => k.go(next, 1, { replaces: writer, kind: "spec-writer" }));
      });
      await run("spec flow: a fresh plan and a ready Spec Writer", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        const fresh = (await plan(k.state, c.chief, [specImpl(1), TEST_WAVE(2)])).threadId;
        await k.delegating("fresh wave 1, kind spec-writer", () => k.go({ ...c, planner: fresh }, 1, { replaces: writer, kind: "spec-writer" }));
      });
      await run("spec flow: a fresh plan and a worker that is not the latest writer", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const fresh = (await plan(k.state, c.chief, [specImpl(1), TEST_WAVE(2)])).threadId;
        await k.delegating("fresh wave 1, replaces a plain worker, kind spec-writer", () => k.go({ ...c, planner: fresh }, 1, { replaces: w1, kind: "spec-writer" }));
        await k.delegating("fresh wave 1, replaces a plain worker, kind worker", () => k.go({ ...c, planner: fresh }, 1, { replaces: w1, kind: "worker" }));
      });
      await run("spec flow: an owed ancestor (b)", async (k) => {
        const c = await k.mk([specImpl(1), P(2), TEST_WAVE(3)]);
        const writer = await k.done(c, 1);
        await k.delegating("wave 2 with no replaces", () => k.go(c, 2));
        await k.delegating("wave 2 replaces the writer", () => k.go(c, 2, { replaces: writer }));
        await k.delegating("wave 3 tester with no replaces", () => k.go(c, 3, { kind: "tester" }));
        await k.delegating("wave 3 tester with a branch", () => k.go(c, 3, { kind: "tester", branch: "tests/after-merge" }));
        const worker = await k.done(c, 1, { replaces: writer, kind: "worker" });
        await k.delegating("wave 2 after the writer's worker", () => k.go(c, 2, { replaces: worker }));
      });
      await run("spec flow: an owed ancestor on a legacy chain", async (k) => {
        const c = await k.mk([specImpl(1), P(2), P(3), TEST_WAVE(4)]);
        const writer = await k.done(c, 1);
        await k.delegating("wave 3, two waves below the owed wave", () => k.go(c, 3));
      });
      await run("spec flow: initial and repair (d)", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.delegating("kind spec-writer, no spec chain", () => k.go(c, 1, { replaces: w1, kind: "spec-writer" }));
        await k.delegating("kind spec-writer on a test wave with no spec chain", () => k.go(c, 2, { replaces: w1, kind: "spec-writer" }));
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.delegating("kind spec-writer replacing a tester, no spec chain", () => k.go(c, 2, { replaces: tester, kind: "spec-writer" }));
      });
      await run("spec flow: repair of a spec chain", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        const worker = await k.done(c, 1, { replaces: writer, kind: "worker" });
        const tester = await k.done(c, 2, { replaces: worker, kind: "tester" });
        await k.delegating("kind spec-writer on wave 1 replaces the superseded writer", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
        await k.delegating("kind spec-writer on wave 2 replaces the wave 1 worker", () => k.go(c, 2, { replaces: worker, kind: "spec-writer" }));
        await k.delegating("kind spec-writer on wave 2 with no replaces", () => k.go(c, 2, { kind: "spec-writer" }));
        await k.delegating("kind spec-writer on wave 1 replaces the tester", () => k.go(c, 1, { replaces: tester, kind: "spec-writer" }));
        await k.delegating("test wave repair: kind spec-writer replaces the tester", () => k.go(c, 2, { replaces: tester, kind: "spec-writer" }));
      });
      await run("spec flow: repair of a spec chain's worker", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        const worker = await k.done(c, 1, { replaces: writer, kind: "worker" });
        await k.delegating("repair: kind spec-writer replaces the worker", () => k.go(c, 1, { replaces: worker, kind: "spec-writer" }));
      });
      await run("spec flow: the spec chain's briefs (specDocs, specSources)", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.delegating("worker after the writer", () => k.go(c, 1, { replaces: writer, kind: "worker" }));
        const worker = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, worker);
        await k.delegating("tester on the spec chain", () => k.go(c, 2, { replaces: worker }));
        const tester = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, tester);
        await k.delegating("Spec Writer repair on the test wave", () => k.go(c, 2, { replaces: tester, kind: "spec-writer" }));
        await k.delegating("worker fix on the test wave of a spec chain", () => k.go(c, 2, { replaces: tester, kind: "worker" }));
      });
      await run("spec flow: specsSkipped", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.acting("skip_specs wave 1", () => k.skipSpecs(c, 1), c.planner);
        await k.delegating("kind spec-writer on a bypassed wave", () => k.go(c, 1, { kind: "spec-writer" }));
        await k.delegating("kind omitted on a bypassed wave", () => k.go(c, 1));
        const w1 = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, w1);
        await k.delegating("tester after a bypassed wave", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("spec flow: baseline flags", async (k) => {
        const c = await k.mk([baseImpl(1), TEST_WAVE(2)]);
        await k.delegating("Spec Writer on a baseline wave", () => k.go(c, 1));
        const writer = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, writer);
        await k.delegating("Spec Writer repair on a baseline wave", () => k.go(c, 1, { replaces: writer, kind: "spec-writer" }));
        const repair = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, repair);
        await k.delegating("worker on a baseline wave", () => k.go(c, 1, { replaces: repair, kind: "worker" }));
        const worker = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, worker);
        await k.delegating("tester walking a baseline ancestor", () => k.go(c, 2, { replaces: worker }));
      });
      await run("spec flow: a mixed chain", async (k) => {
        const c = await k.mk([specImpl(1), baseImpl(2), TEST_WAVE(3)]);
        const writer1 = await k.done(c, 1);
        const worker1 = await k.done(c, 1, { replaces: writer1, kind: "worker" });
        const writer2 = await k.done(c, 2, { replaces: worker1 });
        const worker2 = await k.done(c, 2, { replaces: writer2, kind: "worker" });
        await k.delegating("tester on a mixed spec chain", () => k.go(c, 3, { replaces: worker2 }));
      });
      await run("spec flow: a Spec Writer on a non-spec wave behind an owed wave", async (k) => {
        const c = await k.mk([specImpl(1), P(2), TEST_WAVE(3)]);
        const writer = await k.done(c, 1);
        await k.delegating("wave 2's Spec Writer on a wave that is not spec", () => k.go(c, 2, { kind: "spec-writer" }));
      });

      // 5. Test waves.
      await run("test wave: hand-off from the parent worker", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const lone = (await delegate(k.state, c.chief, "Lone")).threadId;
        await readyIdle(k.state, lone);
        await k.delegating("no replaces", () => k.go(c, 2));
        await k.delegating("kind tester with no replaces", () => k.go(c, 2, { kind: "tester" }));
        await k.delegating("kind tester, a branch, the tested worker not complete", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("replaces an unrelated worker", () => k.go(c, 2, { replaces: lone, kind: "tester" }));
        await k.delegating("kind worker", () => k.go(c, 2, { replaces: w1, kind: "worker" }));
        await k.delegating("kind designer", () => k.go(c, 2, { replaces: w1, kind: "designer" }));
        await k.delegating("kind omitted", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("test wave: kind tester explicit", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.delegating("kind tester", () => k.go(c, 2, { replaces: w1, kind: "tester" }));
      });
      await run("test wave: a worker fix on the same wave", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.delegating("kind omitted", () => k.go(c, 2, { replaces: tester }));
        await k.delegating("kind designer", () => k.go(c, 2, { replaces: tester, kind: "designer" }));
        await k.delegating("kind tester again", () => k.go(c, 2, { replaces: tester, kind: "tester" }));
        await k.delegating("kind worker", () => k.go(c, 2, { replaces: tester, kind: "worker" }));
        const fix = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, fix);
        await k.delegating("kind omitted after the worker fix", () => k.go(c, 2, { replaces: fix }));
        await k.delegating("kind tester after the worker fix", () => k.go(c, 2, { replaces: fix, kind: "tester" }));
      });
      await run("test wave: afterMerge", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await tool(k.state, "chief_complete", { threadId: w1, skipReview: "merged" }, c.chief);
        await k.delegating("no branch", () => k.go(c, 2, { kind: "tester" }));
        await k.delegating("kind omitted with a branch", () => k.go(c, 2, { branch: "tests/after-merge" }));
        await k.delegating("kind worker with a branch", () => k.go(c, 2, { branch: "tests/after-merge", kind: "worker" }));
        await k.delegating("kind tester with a branch", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
      });
      await run("test wave: a tester on a non-test wave", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3)]);
        const w1 = await k.done(c, 1);
        await k.delegating("wave 2 tester replaces wave 1's worker", () => k.go(c, 2, { replaces: w1, kind: "tester" }));
        await k.delegating("wave 1 tester with no replaces", () => k.go(c, 1, { kind: "tester" }));
      });
      await run("test wave: a tester on a plan with no test wave", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.strip(c, w1);
        await k.delegating("no replaces", () => k.go(c, 2, { kind: "tester" }));
        await k.delegating("a branch and no replaces, the tested worker not complete", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("replaces the worker", () => k.go(c, 2, { replaces: w1, kind: "tester" }));
      });
      await run("test wave: a tester on a plan with no test wave, the worker complete", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.strip(c, w1);
        await tool(k.state, "chief_complete", { threadId: w1, skipReview: "merged" }, c.chief);
        await k.delegating("a branch and no replaces", () => k.go(c, 2, { kind: "tester", branch: "tests/after-merge" }));
        await k.delegating("a completed prior replaced by a worker on wave 2", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("test wave: a legacy plan's wave 2 is an ordinary worker", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.strip(c, w1);
        await k.delegating("wave 2 with no kind", () => k.go(c, 2));
        await k.delegating("wave 2 replaces wave 1's worker", () => k.go(c, 2, { replaces: w1 }));
      });

      // 6. Design waves.
      await run("design wave", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.delegating("wave 2 before any designer", () => k.go(c, 2));
        await k.delegating("wave 1, kind omitted", () => k.go(c, 1));
        const designer = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, designer, `${READY}\nArtboards: Checkout`);
        await k.delegating("wave 2 before the owner approves", () => k.go(c, 2, { replaces: designer }));
        await k.delegating("wave 2 with no replaces before the owner approves", () => k.go(c, 2));
        await k.delegating("kind spec-writer on a design wave", () => k.go(c, 1, { replaces: designer, kind: "spec-writer" }));
        await k.delegating("kind tester on a design wave", () => k.go(c, 1, { replaces: designer, kind: "tester" }));
        await tool(k.state, "chief_owner_approval", { workerThreadId: designer, approval: "Looks right, ship it" }, c.chief);
        await k.delegating("wave 2 after approval, replaces the designer", () => k.go(c, 2, { replaces: designer }));
        const w2 = workerOn(k.state, c.planner, 2).thread_id;
        await readyIdle(k.state, w2);
        await k.delegating("tester on a design chain", () => k.go(c, 3, { replaces: w2 }));
      });
      await run("design wave: kind worker and kind designer named", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.delegating("wave 1, kind worker", () => k.go(c, 1, { kind: "worker" }));
        await k.delegating("wave 1, kind designer", () => k.go(c, 1, { kind: "designer" }));
      });
      await run("design wave: wave 2 with no approval after a repeat designer", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.go(c, 1);
        const first = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, first, `${READY}\nArtboards: Checkout`);
        await tool(k.state, "chief_owner_approval", { workerThreadId: first, approval: "Looks right" }, c.chief);
        await k.go(c, 1, { replaces: first });
        const second = workerOn(k.state, c.planner, 1).thread_id;
        await readyIdle(k.state, second, `${READY}\nArtboards: Checkout v2`);
        await k.delegating("wave 2 replaces the unapproved repeat designer", () => k.go(c, 2, { replaces: second }));
        await k.delegating("wave 2 with no replaces, the latest designer unapproved", () => k.go(c, 2));
      });

      // 7. Unplanned work.
      await run("unplanned: Spec Writer hand-off", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.delegating("first delegation: kind spec-writer", () => k.free(chief, { kind: "spec-writer" }));
        const writer = newestId(k.state);
        await readyIdle(k.state, writer);
        await k.delegating("kind omitted", () => k.free(chief, { replaces: writer }));
        await k.delegating("kind tester", () => k.free(chief, { replaces: writer, kind: "tester" }));
        await k.delegating("kind designer", () => k.free(chief, { replaces: writer, kind: "designer" }));
        await k.delegating("kind spec-writer", () => k.free(chief, { replaces: writer, kind: "spec-writer" }));
        await k.delegating("kind worker", () => k.free(chief, { replaces: writer, kind: "worker" }));
      });
      await run("unplanned: Spec Writer not ready", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.free(chief, { kind: "spec-writer" });
        const writer = newestId(k.state);
        await report(k.state, writer, { state: "blocked", result: "Docs unclear", blocker: "Spec delta unclear", recommendation: "Retry" });
        setLive(k.state, writer, "idle");
        await k.delegating("kind worker", () => k.free(chief, { replaces: writer, kind: "worker" }));
        await k.delegating("kind designer", () => k.free(chief, { replaces: writer, kind: "designer" }));
        await k.delegating("kind tester", () => k.free(chief, { replaces: writer, kind: "tester" }));
        await k.delegating("kind spec-writer", () => k.free(chief, { replaces: writer, kind: "spec-writer" }));
      });
      await run("unplanned: tester and the task chain", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.delegating("tester with no prior", () => k.free(chief, { kind: "tester" }));
        await k.free(chief, { title: "Totals", mission: "Fix the totals.", criteria: "Totals never go negative" });
        const worker = newestId(k.state);
        await readyIdle(k.state, worker);
        await k.delegating("tester on the worker", () => k.free(chief, { replaces: worker, kind: "tester" }));
        const tester = newestId(k.state);
        await readyIdle(k.state, tester);
        await k.delegating("Spec Writer on the tester's task chain", () => k.free(chief, { replaces: tester, kind: "spec-writer" }));
        const writer = newestId(k.state);
        await readyIdle(k.state, writer);
        await k.delegating("worker after the chain's Spec Writer", () => k.free(chief, { replaces: writer, kind: "worker" }));
        const fix = newestId(k.state);
        await readyIdle(k.state, fix);
        await k.delegating("tester over a chain with a Spec Writer", () => k.free(chief, { replaces: fix, kind: "tester" }));
      });
      await run("unplanned: a plain worker replaced", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.free(chief, { title: "Totals", mission: "Fix the totals." });
        const worker = newestId(k.state);
        await readyIdle(k.state, worker);
        await k.delegating("kind omitted", () => k.free(chief, { replaces: worker }));
      });
      await run("unplanned: designer", async (k) => {
        const chief = (await start(k.state)).threadId;
        await k.delegating("kind designer", () => k.free(chief, { kind: "designer" }));
      });

      // 8. Waivers.
      await run("skip_tests: refusals before delegation", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.acting("wave 1 is not a test wave", () => k.skipTests(c, 1), c.planner);
        await k.acting("wave 5 is out of range", () => k.skipTests(c, 5), c.planner);
        const unreviewed = (await plan(k.state, c.chief, [P(1), P(2), TEST_WAVE(3)])).threadId;
        await k.acting("an unreviewed plan, wave 1 is not a test wave", () => k.skipTests({ ...c, planner: unreviewed }, 1), unreviewed);
        await k.acting("an unreviewed plan, a test wave", () => k.skipTests({ ...c, planner: unreviewed }, 3), unreviewed);
        const other = await start(k.state, "proj_2");
        await k.acting("another Chief's plan", () => tool(k.state, "chief_skip_tests", { planThreadId: c.planner, wave: 2, reason: "oracle reason" }, other.threadId), c.planner);
      });
      await run("skip_tests: before delegation, the parent not ready", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.go(c, 1);
        await k.acting("waive", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: before delegation, the parent ready", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.done(c, 1);
        await k.acting("waive", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat with another reason", () => tool(k.state, "chief_skip_tests", { planThreadId: c.planner, wave: 2, reason: "another reason" }, c.chief), c.planner);
      });
      await run("skip_tests: before delegation, no worker on the parent", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        await k.acting("waive", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: before delegation on a legacy chain and an independent head", async (k) => {
        const c = await k.mk([P(1), P(2), TEST_WAVE(3), P(4, { dependsOn: [] }), TEST_WAVE(5, [4])]);
        await k.done(c, 1);
        await k.acting("waive wave 3, parent wave 2 undelegated", () => k.skipTests(c, 3), c.planner);
        await k.acting("waive wave 5, parent wave 4 undelegated", () => k.skipTests(c, 5), c.planner);
      });
      await run("skip_tests: a busy and a complete latest worker", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.go(c, 2, { replaces: w1 });
        const tester = workerOn(k.state, c.planner, 2).thread_id;
        setLive(k.state, tester, "active");
        await k.acting("the tester is active", () => k.skipTests(c, 2), c.planner);
        await report(k.state, tester, { state: "ready", result: READY });
        setLive(k.state, tester, "idle");
        await k.acting("the tester is idle after a ready report", () => k.skipTests(c, 2), c.planner);
        await k.acting("repeat", () => k.skipTests(c, 2), c.planner);
        await tool(k.state, "chief_complete", { threadId: tester, skipReview: "reviewed elsewhere" }, c.chief);
        await k.acting("the tester is complete", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: a complete worker after a waiver, and a busy repeat", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        await k.acting("waive after a tester ran", () => k.skipTests(c, 2), c.planner);
        setLive(k.state, tester, "active");
        await k.acting("repeat while the tester is active", () => k.skipTests(c, 2), c.planner);
        setLive(k.state, tester, "idle");
        await tool(k.state, "chief_complete", { threadId: tester, skipReview: "waived" }, c.chief);
        await k.acting("repeat after the tester completed", () => k.skipTests(c, 2), c.planner);
      });
      await run("skip_tests: a blocked tester", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.stuck(c, 2, { replaces: w1 });
        await k.acting("waive after a blocked tester", () => k.skipTests(c, 2), c.planner);
        await k.delegating("kind worker after the waiver on the same wave", () => k.go(c, 2, { replaces: workerOn(k.state, c.planner, 2).thread_id, kind: "worker" }));
      });
      await run("skip_specs: refusals", async (k) => {
        const c = await k.mk([specImpl(1), P(2), TEST_WAVE(3)]);
        await k.acting("wave 2 is not a spec wave", () => k.skipSpecs(c, 2), c.planner);
        await k.acting("wave 3 is a test wave", () => k.skipSpecs(c, 3), c.planner);
        await k.acting("wave 5 is out of range", () => k.skipSpecs(c, 5), c.planner);
        const unreviewed = (await plan(k.state, c.chief, [specImpl(1), P(2), TEST_WAVE(3)])).threadId;
        await k.acting("an unreviewed plan, a spec wave", () => k.skipSpecs({ ...c, planner: unreviewed }, 1), unreviewed);
        await k.acting("an unreviewed plan, wave 2 is not a spec wave", () => k.skipSpecs({ ...c, planner: unreviewed }, 2), unreviewed);
        await k.go(c, 1);
        await k.acting("wave 1 already has its Spec Writer", () => k.skipSpecs(c, 1), c.planner);
      });
      await run("skip_specs: a design wave", async (k) => {
        const c = await k.mk([P(1, { design: true }), P(2), TEST_WAVE(3)]);
        await k.acting("wave 1 is a design wave", () => k.skipSpecs(c, 1), c.planner);
      });
      await run("skip_specs: idempotent repeats", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        await k.acting("waive", () => k.skipSpecs(c, 1), c.planner);
        await k.acting("repeat, no worker yet", () => k.skipSpecs(c, 1), c.planner);
        await k.go(c, 1);
        await k.acting("repeat, the worker delegated", () => k.skipSpecs(c, 1), c.planner);
      });
      await run("skip_specs: a spec wave with a parent", async (k) => {
        const c = await k.mk([P(1), specImpl(2), TEST_WAVE(3)]);
        await k.acting("waive before wave 1 has a worker", () => k.skipSpecs(c, 2), c.planner);
        await k.done(c, 1);
        await k.acting("repeat with wave 1's worker", () => k.skipSpecs(c, 2), c.planner);
      });
      await run("skip_specs: an independent spec head", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2), specImpl(3, { dependsOn: [] }), TEST_WAVE(4, [3])]);
        await k.acting("waive an independent head", () => k.skipSpecs(c, 3), c.planner);
      });
      await run("skip_specs: after the writer's worker", async (k) => {
        const c = await k.mk([specImpl(1), TEST_WAVE(2)]);
        const writer = await k.done(c, 1);
        await k.done(c, 1, { replaces: writer, kind: "worker" });
        await k.acting("the wave already has workers", () => k.skipSpecs(c, 1), c.planner);
      });

      // 9. Loose paths: accepted today, they stay accepted.
      await run("loose: a completed prior is replaced by a tester after skipReview", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        await k.acting("complete with skipReview", () => tool(k.state, "chief_complete", { threadId: w1, skipReview: "small change" }, c.chief), c.planner);
        await k.delegating("tester replaces the completed worker", () => k.go(c, 2, { replaces: w1 }));
      });
      await run("loose: a review starts after a worker fix on a test wave without a rerun", async (k) => {
        const c = await k.mk([P(1), TEST_WAVE(2)]);
        const w1 = await k.done(c, 1);
        const tester = await k.done(c, 2, { replaces: w1 });
        const fix = await k.done(c, 2, { replaces: tester, kind: "worker" });
        await k.acting("review the worker fix", () => tool(k.state, "chief_review", { workerThreadId: fix }, c.chief), c.planner);
      });
      return blocks.join("\n");
    };
    // <plan-admission-oracle-end>

    // Design plans with one implementation wave need no advisor review (design and test waves do not count), so the design blocks
    // no longer spawn an advisor thread: their worker thread ids are one lower than on base c8a0d76 (9 lines of the fixture); nothing else changed.
    test("plan admission oracle", async () => {
      const head = await admissionFixture();
      const oracle = await readFile(join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "plan-admission-c8a0d76.txt"), "utf8");
      const kept = (text: string) => text.split(/^(?==== )/m).filter((block) => !REPLACED_BY_PARALLEL_LANE(block.slice(4, block.indexOf(" ===\n"))));
      expect(kept(oracle).length).toBeGreaterThan(30);
      expect(dropDocsLines(dropSkippedNote(acceptDesignRefusal(acceptOwnership(kept(asBase(head)).join("")))))).toBe(dropDocsLines(kept(oracle).join("")));
    });
  });
});
