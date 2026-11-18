import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import { checkPlan } from "./src/report/reportIntake";
import { CHAIN, CHAIN_B, CHAIN_B_PR, CHAIN_PR, NOT_DOING, SPEC_DELTA, type WriterState, delegateWriter, docsChains, docsWorkList, lastPrompt, fullChain, lastAlert, ownerOn, putWriter, roster, section, skipSpecs, specImpl, specPlan, storedWave, swap, withBoth, withWorker, withWriter, writerOn } from "./test/specWriterHelpers";
import { READY, type State, ctxOf, delegateWave, followRoute, plan, planWave, planWaves, forgeAnswers, openGate, readyIdle, refusal, reviewerVerdict, report, reviewerCount, review, reviewed, rowOf, setLive, tick, tool, workerOn } from "./test/testerHelpers";
import { TEST_FILES, approvePlan, delegate, disposals, disposeAll, latestReviewContext, legacyWave, planFile, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { inPlaceLine } from "./test/blockedAlerts";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
describe("tester role", () => {
  describe("Spec Writer role", () => {
    const workerCall = (planThreadId: string, writer: string, waveNo = 1) => `chief_delegate (planThreadId: ${planThreadId}, wave: ${waveNo}, replaces: ${writer}, kind: worker)`;
    const skipCall = (planThreadId: string, waveNo = 1) => `chief_skip_specs (planThreadId: ${planThreadId}, wave: ${waveNo}, reason)`;
    const countRows = (state: State) => (state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads`).get() as { n: number }).n;
    // Contract (model fallback): MODEL_FALLBACK["spec-writer"]="worker" — with no Spec Writer pick a Spec Writer spawns on
    // the Worker pick, with one on its own pick, a stored pick the machine cannot serve goes to the BB default (and Settings
    // flags it unusable), and a pick stored for another machine changes nothing here. Regression: dropping the fallback sends
    // the unset spawn to the BB default; reading the wrong role's row sends the plain worker to the Spec Writer model.
    test("spec writer model: the Spec Writer pick when set, else the Worker pick, else the BB default when unservable", async () => {
      const state = await setup();
      const set = (hostId: string, role: string, model: string) =>
        state.harness.behavior.callRpc("setRoleModel", { hostId, role, selection: { providerId: "codex", model, reasoningLevel: "high" } });
      await set("host_1", "worker", "gpt-6-mini");
      await set("host_2", "spec-writer", "gpt-6-astra");
      const { chief, planner, writer } = await withWriter(state);
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });

      await set("host_1", "spec-writer", "gpt-6-astra");
      await readyIdle(state, writer);
      const repair = await swap(state, chief, planner.threadId, 1, writer, "spec-writer");
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      // The Spec Writer pick is not the Worker pick: the wave's worker stays on the Worker model.
      await readyIdle(state, repair);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      const worker = ownerOn(state, planner.threadId, 1).thread_id as string;
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
      const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
      expect(configuration.hosts[0]!.selections["spec-writer"]).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      expect(configuration.hosts[0]!.unusable).toEqual([]);

      await set("host_1", "spec-writer", "gpt-5-retired");
      await readyIdle(state, repair);
      await swap(state, chief, planner.threadId, 1, repair, "spec-writer");
      expect(state.spawned.at(-1)).not.toHaveProperty("providerId");
      expect(state.spawned.at(-1)).not.toHaveProperty("model");
      expect((await state.harness.behavior.callRpc("modelConfiguration", null)).hosts[0]!.unusable).toEqual(["spec-writer"]);
    });

    // Contract (model resolution is per machine): a Spec Writer spawns on the picks of the machine its worktree lives on. Two
    // machines with different Worker and Spec Writer picks, each repair made through chief_delegate on that machine's
    // environment: host_1 has its own Spec Writer pick, host_2 has none and inherits host_2's Worker pick, so neither
    // machine's pick reaches the other. Regression: a resolver that always reads the first machine sends host_2's Spec Writer
    // to host_1's Spec Writer model; one that reads the Worker row of the wrong machine sends it to host_1's Worker model.
    test("spec writer model: each spawn uses the picks of its own machine", async () => {
      const state = await setup();
      const set = (hostId: string, role: string, providerId: string, model: string) =>
        state.harness.behavior.callRpc("setRoleModel", { hostId, role, selection: { providerId, model, reasoningLevel: "medium" } });
      await set("host_1", "worker", "codex", "gpt-6-mini");
      await set("host_1", "spec-writer", "codex", "gpt-6-astra");
      await set("host_2", "worker", "claude-code", "claude-opus-5");
      const hostTwo = new Set<string>();
      state.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
        id: environmentId, hostId: hostTwo.has(environmentId) ? "host_2" : "host_1", workspaceProvisionType: environmentId.startsWith("env_worker") ? "managed-worktree" : null,
      }));
      const chief = await start(state);
      const chains = [];
      for (const host of ["host_1", "host_2"]) {
        const planner = await plan(state, chief.threadId, [specImpl()]);
        const writer = await delegateWriter(state, chief, planner.threadId, 1, { branch: `feature/${host}` });
        if (host === "host_2") hostTwo.add(state.live.get(writer)!.environmentId as string);
        await readyIdle(state, writer);
        chains.push({ planner, writer });
      }
      const spawnRepair = async ({ planner, writer }: (typeof chains)[number]) => {
        await swap(state, chief, planner.threadId, 1, writer, "spec-writer");
        return state.spawned.at(-1);
      };
      expect(await spawnRepair(chains[0]!)).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      expect(await spawnRepair(chains[1]!)).toMatchObject({ providerId: "claude-code", model: "claude-opus-5" });
    });

    // Contract (chief_models_v8 migration, storage): a v7 database keeps all seven roles on two machines unchanged, then
    // accepts a spec-writer row and still refuses an unknown role. Regression: the rebuild drops a role or machine's row,
    // or leaves the old CHECK list so a Spec Writer pick cannot be saved.
    test("chief_models_v8 migration keeps every v7 model row and accepts a Spec Writer pick", async () => {
      const { bb, harness } = createFakePluginHost({ pluginId: "chief-upgrade-spec-writer" });
      disposals.push(() => harness.lifecycle.dispose());
      const db = bb.storage.database();
      bb.storage.migrate(db, MIGRATIONS.slice(0, MIGRATIONS.findIndex((statement) => statement.includes("chief_models_v8"))));
      const insert = db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
      expect(() => insert.run("host_1", "spec-writer", "codex", "gpt-6-mini", "low", 0)).toThrow();
      const roles = ["chief", "planner", "worker", "reviewer", "advisor", "designer", "tester"];
      for (const host of ["host_1", "host_2"]) roles.forEach((role, i) => insert.run(host, role, "codex", `model-${host}-${role}`, "high", i + 1));
      const before = db.prepare(`SELECT * FROM chief_models ORDER BY host_id, role`).all();
      expect(before).toHaveLength(14);

      bb.storage.migrate(db, MIGRATIONS);

      expect(db.prepare(`SELECT * FROM chief_models ORDER BY host_id, role`).all()).toEqual(before);
      expect(() => insert.run("host_1", "spec-writer", "codex", "gpt-6-mini", "low", 100)).not.toThrow();
      expect(db.prepare(`SELECT model FROM chief_models WHERE host_id='host_1' AND role='spec-writer'`).get()).toEqual({ model: "gpt-6-mini" });
      expect(() => insert.run("host_1", "junior", "codex", "gpt-6-mini", "low", 101)).toThrow();
    });

    // Contract 1 (checkPlan, spec flag): spec is a boolean on an implementation wave whose body has a Spec delta heading; a test
    // or design wave never carries it. Regression: dropping the heading rule lets a docs step with no work list through;
    // dropping the test/design rule lets a Spec Writer be scheduled where no worker implements; dropping the copy loses the flag.
    test.each<[string, object[], RegExp[]]>([
      ["accepts spec: true on an implementation wave with a Spec delta heading", [specImpl(1)], []],
      ["accepts a Spec delta heading at any level", [specImpl(1, { body: wave(1, "Build.\n\n### spec delta\n- docs/x.md") + NOT_DOING })], []],
      ["refuses a non-boolean spec", [planWave(1, { spec: "yes" })], [/plan wave 1 spec is "yes" \(string\); allowed true or false\. Send a boolean, or drop spec\./]],
      ["refuses spec: true on a design wave", [planWave(1, { design: true, spec: true, body: wave(1, `Draw.\n\n${SPEC_DELTA}`) }), planWave(2)], [/plan wave 1 is spec: true and design: true; spec marks an implementation wave only\./]],
      ["refuses spec: true with no Spec delta heading", [planWave(1, { spec: true })], [/plan wave 1 is spec: true but lacks a "## Spec delta" Markdown heading naming the docs the Spec Writer changes/]],
      ["refuses a Spec delta named only in bold text", [specImpl(1, { body: wave(1, "**Spec delta**\n- docs/x.md") + NOT_DOING })], [/plan wave 1 is spec: true but lacks a "## Spec delta"/]],
      ["accepts a Spec baseline heading on a spec wave", [specImpl(1, { body: wave(1, `Build.\n\n${SPEC_DELTA}\n\n## Spec baseline\n- docs/specs/totals.md (new): totals.ts`) + NOT_DOING })], []],
      ["accepts a Spec baseline heading at another level on a spec wave", [specImpl(1, { body: wave(1, `Build.\n\n${SPEC_DELTA}\n\n#### spec baseline\n- docs/specs/totals.md (new): totals.ts`) + NOT_DOING })], []],
      ["refuses a Spec baseline heading on a wave that is not spec: true", [planWave(1, { body: wave(1, "Build.\n\n## Spec baseline\n- docs/specs/totals.md (new): totals.ts") + NOT_DOING })], [/plan wave 1 has a "## Spec baseline" heading but is not spec: true; a baseline belongs to the spec wave that creates a new docs\/specs file\. Mark the wave spec: true, or drop the heading\./]],
      ["ignores Spec baseline in bold text on a wave that is not spec: true", [planWave(1, { body: wave(1, "Build.\n\n**Spec baseline**\n- docs/x.md") + NOT_DOING })], []],
    ])("checkPlan %s", (_name, input, expected) => {
      const errors = checkPlan(input);
      if (!expected.length) expect(errors).toEqual([]);
      for (const pattern of expected) expect(errors.join("\n")).toMatch(pattern);
    });

    test("a planner's spec flag is stored on the flagged implementation wave only", async () => {
      const state = await setup();
      const { planner } = await specPlan(state, [specImpl(1), { body: wave(3), dependsOn: [] }]);
      expect(JSON.parse(planWaves(state, planner.threadId)).map((entry: any) => entry.spec)).toEqual([true, undefined]);
    });


    const writerCall = (planThreadId: string, writer: string, waveNo = 1) => `chief_delegate (planThreadId: ${planThreadId}, wave: ${waveNo}, replaces: ${writer}, kind: spec-writer)`;
    const sideEnv = (branch: string) => ({ type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: branch } } });
    const waitWriters = (waveNo: number, total: number) => new RegExp(`Wave ${waveNo} of ${total} is ready; the Spec Writer of .* is not ready yet\\. Wait for its ready report`);
    const testerCall = (planThreadId: string, waveNo: number, owner: string) => `chief_delegate (planThreadId: ${planThreadId}, wave: ${waveNo}, replaces: ${owner}, kind: tester)`;

    // Wave 1 contract 1 (default kind) and contract 16 (planner-ready line): a spec wave's first call with no kind admits a worker; the
    // Spec Writer needs kind spec-writer; the planner-ready alert names both calls. #202: a design wave still defaults to a designer.
    // Regression: the old default (writer first) comes back, or the alert still says the writer runs first.
    test("a spec wave's default kind is worker; its Spec Writer is an explicit second call", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state);
      const P = planner.threadId;
      expect(lastAlert(state)).toContain(`chief_delegate (planThreadId: ${P}, wave: 1, kind: spec-writer)`);
      expect(lastAlert(state)).toContain("works in its own worktree");
      expect(lastAlert(state)).not.toMatch(/before its worker|it starts with its Spec Writer/);
      await delegateWave(state, chief.threadId, P, 1);
      const worker = ownerOn(state, P, 1);
      expect(worker).toMatchObject({ kind: null, role: "worker" });
      expect(state.spawned.at(-1).prompt).not.toContain("you run before its worker");
      expect(writerOn(state, P, 1)).toBeUndefined();

      const design = await specPlan(state, [planWave(1, { design: true }), specImpl(2)]);
      await delegateWave(state, design.chief.threadId, design.planner.threadId, 1);
      expect(ownerOn(state, design.planner.threadId, 1)).toMatchObject({ kind: "designer" });
      await expect(delegateWave(state, design.chief.threadId, design.planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow("Wave 1 is design-only: it changes no repository files. Route its docs need to wave 2");
    });

    // Wave 1 contract 15: chief_skip_specs works while only the worker exists and is refused once any spec-writer row does; its reply
    // asks for the worker with no kind. A non-spec wave is refused. Regression: the old before-any-row rule comes back (refuses a
    // worker-only wave), or a writer row no longer blocks the waiver (a later bypass would orphan a live writer).
    test("chief_skip_specs bypasses the Spec Writer until one was delegated on the wave", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state);
      const P = planner.threadId;
      const before = JSON.parse(planWaves(state, P));
      const text = await skipSpecs(state, chief.threadId, P, "docs already describe this");
      expect(text).toContain(`Specs on wave 1 bypassed: delegate its worker — chief_delegate (planThreadId: ${P}, wave: 1)`);
      expect(text).not.toContain("kind: worker");
      expect(JSON.parse(planWaves(state, P))[0]).toEqual({ ...before[0], specsSkipped: "docs already describe this" });
      expect(JSON.parse(planWaves(state, P))[1]).toEqual(before[1]);
      const stored = planWaves(state, P);
      expect(await skipSpecs(state, chief.threadId, P, "another reason")).toBe(text);
      expect(planWaves(state, P)).toBe(stored);
      // A waived spec wave takes an implementation-lane writer only, replacing the chain owner: with no worker yet there is none to replace.
      await expect(delegateWave(state, chief.threadId, P, 1, { kind: "spec-writer" })).rejects.toThrow("no worker has started wave 1's chain yet");
      await delegateWave(state, chief.threadId, P, 1);
      expect(await skipSpecs(state, chief.threadId, P)).toBe("Specs on wave 1 were already bypassed.");
      await expect(skipSpecs(state, chief.threadId, P, "r", 2)).rejects.toThrow(`Wave 2 of planner ${P} is not a spec: true implementation wave.`);
      const plain = await plan(state, chief.threadId);
      await expect(skipSpecs(state, chief.threadId, plain.threadId)).rejects.toThrow(`Wave 1 of planner ${plain.threadId} is not a spec: true implementation wave.`);
    });

    test("chief_skip_specs works while only the worker exists", async () => {
      const state = await setup();
      const { chief, planner, worker } = await withWorker(state);
      await skipSpecs(state, chief.threadId, planner.threadId, "docs are unchanged");
      expect(storedWave(state, planner.threadId).specsSkipped).toBe("docs are unchanged");
      expect(rowOf(state, worker).state).not.toBe("complete");
      await expect(delegateWriter(state, chief, planner.threadId)).rejects.toThrow(`A Spec Writer here replaces the chain's current implementation row: chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${worker}, kind: spec-writer).`);
    });

    test.each([["the writer alone", false], ["the writer beside its worker", true]])("chief_skip_specs is refused once the wave has a Spec Writer row: %s", async (_label, both) => {
      const state = await setup();
      const { chief, planner } = both ? await withBoth(state) : await withWriter(state);
      await expect(skipSpecs(state, chief.threadId, planner.threadId)).rejects.toThrow("chief_skip_specs only bypasses a Spec Writer that was never delegated on the wave");
      expect(storedWave(state, planner.threadId).specsSkipped).toBeUndefined();
    });

    const WRITER_STATES: WriterState[] = ["ready", "ready and idle", "blocked", "idle with no report", "complete"];
    const isReady = (how: WriterState) => how === "ready" || how === "ready and idle" || how === "complete";

    // Wave 1 contract 8: later implementation waves are admitted while a writer is pending; only a test wave waits. Regression: the
    // old owed-ancestor rule comes back and gates wave 2 behind wave 1's writer.
    test("a later implementation wave is admitted while the writer of an earlier wave is pending", async () => {
      const state = await setup();
      const { chief, planner, worker, writer } = await withBoth(state, [specImpl(1), planWave(2)]);
      await readyIdle(state, worker);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: worker });
      expect(ownerOn(state, planner.threadId, 2)).toMatchObject({ plan_wave: 2, replaces_thread_id: worker });
      expect(rowOf(state, writer).state).not.toBe("complete");
    });

    // Wave 1 contracts 4 and 7 (holder matrix + docs repair): the side-lane writer is replaced by a writer only; the repair gets a fresh
    // managed worktree cut from the task branch (never the old side checkout, which may hold stale or half-rebased docs commits), completes
    // the old writer; every other kind is refused naming the chain's owner; a live writer is not replaced by
    // a second one. Regression: any kind may replace a writer (the worker takes over the side worktree), or the repair reuses the old checkout.
    test("a side-lane writer's docs repair gets a fresh worktree on the task branch; every other kind is refused naming the chain's worker", async () => {
      const state = await setup();
      const { chief, planner, worker, writer } = await withBoth(state);
      const P = planner.threadId;
      // A live writer is not shadowed by a second one that replaces nothing; replacing it is the docs fix itself.
      await expect(delegateWave(state, chief.threadId, P, 1, { kind: "spec-writer" })).rejects.toThrow(
        `Wave 1's Spec Writer ${writer} is still live: fix its docs with chief_delegate (planThreadId: ${P}, wave: 1, replaces: ${writer}, kind: spec-writer).`);
      await putWriter(state, chief.threadId, writer, "blocked");
      const rows = countRows(state);
      for (const kind of ["worker", "designer", "tester"]) {
        await expect(delegateWave(state, chief.threadId, P, 1, { replaces: writer, kind })).rejects.toThrow(
          new RegExp(`${writer} is wave 1's Spec Writer, which works in its own side worktree: only its docs fix replaces it — chief_delegate \\(planThreadId: ${P}, wave: 1, replaces: ${writer}, kind: spec-writer\\)\\. Product and test work continues the chain's implementation row — .*${worker}`));
      }
      expect(countRows(state)).toBe(rows);
      const environment = state.live.get(writer)!.environmentId;
      await delegateWave(state, chief.threadId, P, 1, { replaces: writer, kind: "spec-writer" });
      const repair = writerOn(state, P, 1);
      expect(repair).toMatchObject({ kind: "spec-writer", replaces_thread_id: writer, plan_wave: 1, branch: CHAIN });
      expect(state.spawned.at(-1).environment).toEqual({ type: "host", hostId: expect.any(String), workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: CHAIN } } });
      expect(state.live.get(repair.thread_id)!.environmentId).not.toBe(environment);
      const brief = String(state.spawned.at(-1).prompt);
      expect(brief).toContain("Your worktree is fresh from");
      expect(brief).not.toContain("already holds the previous worker's changes");
      expect(brief).toContain("never cherry-pick or merge the previous writer's commits");
      expect(rowOf(state, writer).state).toBe("complete");
      expect(countRows(state)).toBe(rows + 1);
      expect(ownerOn(state, P, 1).thread_id).toBe(worker);
    });

    // Wave 1 contract 7 (ready writer): a ready side-lane writer's repair is also a writer, and a worker is still refused.
    test.each(["ready", "ready and idle"] as WriterState[])("a %s side-lane writer is repaired by a writer only", async (how) => {
      const state = await setup();
      const { chief, planner, writer } = await withBoth(state);
      await putWriter(state, chief.threadId, writer, how);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind: "worker" })).rejects.toThrow(/only its docs fix replaces it/);
      if (how === "ready") setLive(state, writer, "idle");
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind: "spec-writer" });
      expect(writerOn(state, planner.threadId, 1)).toMatchObject({ replaces_thread_id: writer });
    });

    // Wave 1 contract 5 (continue refusal): a ready side-lane writer is never continued; the refusal names its fresh-worktree retry, while a ready
    // chain worker's refusal still says its worktree is kept. Regression: the side-lane refusal promises the same worktree the repair no longer gets.
    test("chief_continue on a ready side-lane writer says the retry starts a fresh worktree; a ready chain worker keeps its worktree", async () => {
      const state = await setup();
      const { chief, worker, writer } = await withBoth(state);
      await putWriter(state, chief.threadId, writer, "ready");
      await readyIdle(state, worker);
      const sent = state.sent.length;
      await expect(tool(state, "chief_continue", { threadId: writer, instruction: "Keep going" }, chief.threadId)).rejects.toThrow(
        `chief_delegate (replaces: ${writer}, kind: spec-writer) for a docs fix starts a fresh worktree on the same branch and pull request`);
      await expect(tool(state, "chief_continue", { threadId: worker, instruction: "Keep going" }, chief.threadId)).rejects.toThrow(
        /keeps the same worktree, branch, and pull request/);
      expect(state.sent).toHaveLength(sent);
    });

    // Wave 1 contract 3 (first side writer): it needs the chain's branch (a mismatch is refused) and, on a later wave with no worker
    // yet, a settled chain owner; the admitted writer takes the owner's branch and PR. Regression: a writer starts a second chain on its
    // own branch, or starts beside a parent wave whose worker is still running.
    test("a first side-lane writer needs the chain's branch and a ready parent wave", async () => {
      const state = await setup();
      const { chief, planner, worker } = await withWorker(state, [specImpl(1), specImpl(2)]);
      const P = planner.threadId;
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, P, 1, { kind: "spec-writer", branch: "feature/other", prUrl: CHAIN_PR })).rejects.toThrow(
        `branch feature/other is not the chain's branch ${CHAIN} (worker ${worker}); a Spec Writer folds onto the chain's one branch.`);
      await expect(delegateWave(state, chief.threadId, P, 2, { kind: "spec-writer" })).rejects.toThrow(
        `Wave 2 builds on wave 1, which has not reported ready: its Spec Writer starts once the chain's worker is ready (${worker} is ${rowOf(state, worker).state}).`);
      expect(countRows(state)).toBe(rows);
      await readyIdle(state, worker);
      await delegateWave(state, chief.threadId, P, 2, { kind: "spec-writer" });
      expect(writerOn(state, P, 2)).toMatchObject({ kind: "spec-writer", plan_wave: 2, replaces_thread_id: null, branch: CHAIN, pr_url: CHAIN_PR });
      expect(state.spawned.at(-1).environment).toEqual(sideEnv(CHAIN));
      expect(countRows(state)).toBe(rows + 1);
    });

    // Wave 1 contract 14 (completion): a side-lane writer completes like a worker — a covering approve, skipReview or override; plain
    // with no approve is refused. Regression: the old never-complete rule is applied to the side lane, or a writer completes with no review.
    test("chief_complete refuses a side-lane writer with no approve and accepts skipReview and override", async () => {
      const state = await setup();
      const { chief, writer } = await withBoth(state);
      await readyIdle(state, writer);
      const refused = await tool(state, "chief_complete", { threadId: writer }, chief.threadId).catch((error: Error) => error.message);
      expect(refused).toMatch(/review|approve/i);
      expect(refused).not.toContain("a Spec Writer's docs need");
      expect(rowOf(state, writer).state).toBe("ready");
      await tool(state, "chief_complete", { threadId: writer, skipReview: "docs only" }, chief.threadId);
      expect(rowOf(state, writer).state).toBe("complete");
    });
    test("chief_complete accepts a side-lane writer with override", async () => {
      const state = await setup();
      const { chief, writer } = await withBoth(state);
      await readyIdle(state, writer);
      await tool(state, "chief_complete", { threadId: writer, override: "no approve" }, chief.threadId);
      expect(rowOf(state, writer).state).toBe("complete");
    });

    // An implementation-lane Spec Writer replaces the chain's current implementation row only: with wave 2 owning the chain, a writer
    // replacing wave 1's worker is refused naming wave 2's worker. Regression: a writer replaces a row that is not the chain's latest.
    test("an implementation-lane Spec Writer replacing a row that is not its wave's latest is refused", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [planWave(1), planWave(2)]);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR });
      const w1 = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, w1);
      const w2 = await swap(state, chief, planner.threadId, 2, w1, "worker");
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: w1, kind: "spec-writer" })).rejects.toThrow(
        `A Spec Writer here replaces the chain's current implementation row: chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${w2}, kind: spec-writer).`);
      expect(countRows(state)).toBe(rows);
    });

    test("a design wave refuses a Spec Writer, and a bypassed spec wave never has a pending writer", async () => {
      const state = await setup();
      const bypassed = await specPlan(state);
      await skipSpecs(state, bypassed.chief.threadId, bypassed.planner.threadId, "docs are unchanged");
      await delegateWave(state, bypassed.chief.threadId, bypassed.planner.threadId, 1);
      const b1 = workerOn(state, bypassed.planner.threadId, 1).thread_id as string;
      expect(rowOf(state, b1).kind).toBeNull();
      await readyIdle(state, b1);
      expect(lastAlert(state)).not.toMatch(waitWriters(1, 1));

      const design = await specPlan(state, [planWave(1, { design: true }), specImpl(2)]);
      await expect(delegateWave(state, design.chief.threadId, design.planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow("Wave 1 is design-only: it changes no repository files. Route its docs need to wave 2");
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE kind='spec-writer'`).get()).toEqual({ n: 0 });
    });

    // Wave 1 contract 13 (legacy data), through the real owners: S1→W1→S2→W2 with S2 complete makes no wave pending (the tester is
    // admitted and the review runs); a ready legacy head S1 with no worker is replaced by a worker or designer; a ready legacy S2 that
    // replaced W1 is handed off as the implementation row and keeps the implementation-lane completion refusal.
    // Regression: the writer-pending rule reads the old sequential shape as pending (stranding finished chains), the legacy head can
    // no longer reach its worker, or a legacy implementation-lane writer is treated as a side-lane one.
    test("a completed legacy S1→W1→S2→W2 chain has no pending writer: its ready alert waits for nothing", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), specImpl(2)], true);
      const P = planner.threadId;
      const s1 = await legacyRow(state, chief.threadId, P, 1, "spec-writer", null, "feature/legacy");
      const w1 = await legacyRow(state, chief.threadId, P, 1, null, s1, "feature/legacy");
      const s2 = await legacyRow(state, chief.threadId, P, 2, "spec-writer", w1, "feature/legacy");
      const w2 = await legacyRow(state, chief.threadId, P, 2, null, s2, "feature/legacy");
      for (const id of [s1, w1, s2]) state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id=?`).run(id);
      await readyIdle(state, w2);
      expect(lastAlert(state)).not.toMatch(waitWriters(2, 2));
    });

    test.each(["worker", "designer"])("a ready legacy head Spec Writer with no worker is replaced by a %s", async (kind) => {
      const state = await setup();
      const { chief, planner } = await specPlan(state);
      const s1 = await legacyRow(state, chief.threadId, planner.threadId, 1, "spec-writer", null, "feature/legacy");
      await readyIdle(state, s1);
      const priorEnv = state.live.get(s1)!.environmentId;
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: s1, kind });
      const successor = ownerOn(state, planner.threadId, 1);
      expect(successor).toMatchObject({ kind: kind === "worker" ? null : kind, replaces_thread_id: s1, branch: "feature/legacy" });
      // Wave 2 C8: the legacy hand-off is implementation-lane, so it reuses the prior writer's environment (never a fresh managed worktree).
      expect(state.spawned.at(-1).environment).toEqual({ type: "reuse", environmentId: priorEnv });
      expect(state.live.get(successor.thread_id as string)!.environmentId).toBe(priorEnv);
    });

    test("a ready legacy S2 that replaced W1 is handed off as the implementation row and is never completed by itself", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), specImpl(2)], true);
      const P = planner.threadId;
      const s1 = await legacyRow(state, chief.threadId, P, 1, "spec-writer", null, "feature/legacy");
      const w1 = await legacyRow(state, chief.threadId, P, 1, null, s1, "feature/legacy");
      const s2 = await legacyRow(state, chief.threadId, P, 2, "spec-writer", w1, "feature/legacy");
      state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id IN (?, ?)`).run(s1, w1);
      await readyIdle(state, s2);
      await expect(tool(state, "chief_complete", { threadId: s2, skipReview: "docs only" }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${s2}: a Spec Writer's docs need their worker — chief_delegate (planThreadId: ${P}, wave: 2, replaces: ${s2}, kind: worker).`);
      const priorEnv = state.live.get(s2)!.environmentId;
      await delegateWave(state, chief.threadId, P, 2, { replaces: s2, kind: "worker" });
      expect(ownerOn(state, P, 2)).toMatchObject({ kind: null, replaces_thread_id: s2 });
      expect(state.spawned.at(-1).environment).toEqual({ type: "reuse", environmentId: priorEnv });
    });

    /** A blocked wave-1 side-lane writer on plan P (branch A) and a fresh plan Q with `waves`. */
    async function crossPlan(state: State, how: WriterState, waves: object[] = [specImpl(1)]) {
      const first = await withWriter(state, undefined, { branch: "feature/a" });
      await putWriter(state, first.chief.threadId, first.writer, how);
      const fresh = await plan(state, first.chief.threadId, waves);
      if (waves.length > 2) await approvePlan(state, first.chief.threadId, fresh.threadId);
      return { ...first, fresh };
    }
    const sideOnly = (planId: string, writer: string) => new RegExp(`${writer} is wave 1's Spec Writer, which works in its own side worktree: only its docs fix replaces it — chief_delegate \\(planThreadId: ${planId}, wave: 1, replaces: ${writer}, kind: spec-writer\\)`);

    // Wave 1 contract 4 (the freshPlan exception, per lane): a fresh plan's wave 1 Spec Writer replaces a blocked side-lane writer of
    // another plan, on its branch; the old writer is closed out. Regression: the exception is dropped (a writer that cannot write its
    // delta can never be recovered) or widened past kind spec-writer, wave 1 and a blocked writer.
    test("a fresh plan's wave 1 Spec Writer replaces a blocked side-lane writer of another plan", async () => {
      const state = await setup();
      const { chief, writer, fresh } = await crossPlan(state, "blocked");
      await delegateWave(state, chief.threadId, fresh.threadId, 1, { replaces: writer, kind: "spec-writer" });
      expect(writerOn(state, fresh.threadId, 1)).toMatchObject({ kind: "spec-writer", plan_wave: 1, replaces_thread_id: writer, branch: "feature/a" });
      expect(rowOf(state, writer).state).toBe("complete");
    });

    test.each<[string, object[], number, string, (planId: string, writer: string) => string | RegExp]>([
      ["kind worker", [specImpl(1)], 1, "worker", (planId, writer) => sideOnly(planId, writer) as any],
      ["kind designer", [specImpl(1)], 1, "designer", (planId, writer) => sideOnly(planId, writer) as any],
      ["a fresh wave 1 that is not spec: true", [planWave(1)], 1, "spec-writer", () => "A Spec Writer here replaces the chain's current implementation row"],
    ])("a blocked side-lane writer of another plan is not replaced by %s", async (_label, waves, target, kind, message) => {
      const state = await setup();
      const { chief, writer, planner, fresh } = await crossPlan(state, "blocked", waves);
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, fresh.threadId, target, { replaces: writer, kind })).rejects.toThrow(message(planner.threadId, writer));
      expect(countRows(state)).toBe(rows);
      expect(rowOf(state, writer).state).toBe("blocked");
    });

    test.each<WriterState>(["ready", "ready and idle", "idle with no report", "complete"])("a side-lane writer of another plan that is %s is not replaced by a fresh plan's writer", async (how) => {
      const state = await setup();
      const { chief, writer, fresh } = await crossPlan(state, how);
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, fresh.threadId, 1, { replaces: writer, kind: "spec-writer" })).rejects.toThrow();
      expect(countRows(state)).toBe(rows);
    });

    /** wave 1's worker, wave 2's tester on a plan: with a Spec Writer beside the worker (spec chain) or without (no spec). Returns the tester, blocked and idle. */
    async function blockedTester(state: State, spec: boolean) {
      const ctx = await specPlan(state, spec ? undefined : [planWave(1)]);
      const { chief, planner } = ctx;
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR });
      const head = workerOn(state, planner.threadId, 1).thread_id as string;
      if (spec) await readyIdle(state, await delegateWriter(state, chief, planner.threadId, 1));
      await readyIdle(state, head);
      const tester = await swap(state, chief, planner.threadId, 2, head, "tester");
      await report(state, tester, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
      setLive(state, tester, "idle");
      return { ...ctx, tester };
    }

    // Wave 1 contract 16 (blocked side-lane writer): the retry route (a fold conflict takes it too) and the fresh-plan route, never a worker.
    test("a blocked side-lane Spec Writer's alert offers a retry and a fresh plan, never a worker", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withBoth(state);
      await report(state, writer, { state: "blocked", result: "Cannot write the delta", blocker: "Delta names no domain", recommendation: "Re-plan" });
      const alert = lastAlert(state);
      const paths = [1].map((n) => planFile(state, planner.threadId, n)).join(", ");
      const full = `Spec Writer blocked: Delta names no domain. ${inPlaceLine(writer)} Retry it with the fix: chief_delegate (replaces: ${writer}, kind: spec-writer); a docs/ fold conflict on the branch takes the same route (the retry gets a fresh worktree from ${rowOf(state, writer).branch}). The retry gets this wave's \`## Docs needed\` items with the blocker; one repair per wave, not separate fix and fold writers. `
        + `If the Spec delta cannot be written: start a fresh chief_plan with the plan files (${paths}), this blocked report (bb chief inspect ${writer}), branch ${rowOf(state, writer).branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${writer}, kind: spec-writer.`;
      expect(alert).toContain(full.slice(0, full.indexOf("with the plan files")));
      expect(await roster(state, chief.threadId)).toContain(full);
      expect(alert).not.toContain("kind: worker");
      expect(full).not.toContain("kind: worker");
    });

    // Wave 1 contract 16 (blocked alerts, other lanes): a blocked chain worker's alert offers the in-place answer beside its spec routes; a blocked
    // implementation-lane Spec Writer's alert offers it too but makes no fresh-worktree claim (its retry reuses the checkout). Regression: the
    // in-place line is dropped from a spec chain, or the fresh-worktree claim leaks to a lane that still reuses its worktree.
    test("a blocked chain worker's alert offers the in-place answer", async () => {
      const state = await setup();
      const { chief, worker } = await withBoth(state);
      await report(state, worker, { state: "blocked", result: "Command denied", blocker: "git push is denied", recommendation: "Allow it" });
      expect(lastAlert(state)).toContain(`Blocked: git push is denied — decide or escalate to the user. ${inPlaceLine(worker)}`);
      expect(await roster(state, chief.threadId)).toContain(`${inPlaceLine(worker)} If the spec is wrong: chief_delegate (replaces: ${worker}, kind: spec-writer) with the fix, with the docs items in the mission.`);

    });

    let legacySeed = 0;
    const legacyRow = async (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, kind: string | null, replaces: string | null, branch: string) => {
      // The CLI refuses a second live row on one branch, so each row is seeded on its own and then moved onto the chain's branch.
      const { threadId } = await legacyWave(state, chiefThreadId, planThreadId, waveNo, `${branch}-seed-${(legacySeed += 1)}`);
      state.db.prepare(`UPDATE managed_threads SET kind=?, replaces_thread_id=?, branch=? WHERE thread_id=?`).run(kind, replaces, branch, threadId);
      return threadId;
    };
    const BASE_HEAD = "- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start and as `Head commit: <sha>` when you report.";
    // Wave 2 of the shrink-prompts plan: the brief keeps the dynamic values (branch, record name, push command); the sync and rebase rules live in the skills.
    const localSync = (branch: string, label = "Local sync") => `Task branch: ${branch}. After loading your skills and before any other file read, sync and record \`${label}: <sha>\`; push every commit with \`git push origin HEAD:${branch}\`; follow the git workflow in your loaded skills.`;
    const BLOCKED_PLAN = "- If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan.";
    const WORKER_SPEC_RULES = [
      "Read each Spec Writer report below (`bb chief inspect <id>`), docs/INDEX.md and the specs those reports changed, and implement to match them.",
      "- If the spec is wrong, report blocked and recommend `chief_delegate (replaces: <your thread id>, kind: spec-writer)`. If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan.",
      BASE_HEAD,
    ];

    // Wave 2 contracts 2 and 4 (worker brief): a spec wave's worker or designer builds from the plan and never waits for the writer's
    // docs; it keeps Base/Head and the fresh-plan route, rebases a rejected push with no autostash, and has no "implement to match them"
    // and no spec-writer replace route; every implementation-lane prompt with a branch carries the pre-read local sync.
    // Regression: the worker brief still says it implements against the writer's docs, or loses the sync or the rebase rule.
    test.each(["worker", "designer"])("a spec wave's %s builds from the plan: stale-spec, no-wait and rejected-push rules, no writer route", async (kind) => {
      const state = await setup();
      const { chief, planner } = await specPlan(state);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR, ...(kind === "designer" ? { kind } : {}) });
      const prompt = state.spawned.at(-1).prompt as string;
      expect(section(prompt, "Spec")).toBe([
        "The plan file is your source of truth. Pre-plan specs may be stale for the domains this wave touches: where they conflict with the plan, follow the plan and name the conflict in your report. A Spec Writer records this change in docs/ in parallel: do not wait for it and do not implement against its docs.",
        BLOCKED_PLAN,
        BASE_HEAD,
      ].join("\n") + "\n");
      expect(section(prompt, "Git workflow")).toContain(localSync(CHAIN));
      expect(prompt).not.toMatch(/implement to match them|kind: spec-writer|you run before its worker/);
    });

    // Side-lane writer prompt: the `## Fold` section names the chain branch and sends the writer to the skill's Fold steps; the side branch is never pushed
    // except through them, and none of the run-first wording or the "commit and push after each step" rule survives.
    // Regression: the Fold section loses the target branch, or the writer is told to push the side branch.
    test("a side-lane Spec Writer's prompt names the fold target and the skill's Fold steps, with none of the run-first wording", async () => {
      const state = await setup();
      const { writer } = await withWriter(state);
      const prompt = state.spawned.at(-1).prompt as string;
      expect(section(prompt, "Wave")).toContain("Wave 1 of 1: you run in parallel with its worker, in your own worktree on a side branch cut from feature/chain.");
      expect(section(prompt, "Fold")).toBe(`Fold your docs/ commits onto ${CHAIN}: follow section 10 (Fold) of the \`chief-role-spec-writer\` skill with <branch> = ${CHAIN}, and record Fold base and Fold head.\n`);
      expect(section(prompt, "Git workflow")).toContain(`Side branch cut from ${CHAIN}: commit only docs/ on it and push only through the \`## Fold\` steps.`);
      expect(prompt).toContain("A delta item the docs already reflect needs no commit: say so, and record `Fold: none`.");
      expect(prompt).not.toMatch(/you run before its worker|git diff --name-only <base>\.\.HEAD|Commit and push after each meaningful step|Commit and push your work/);
      expect(rowOf(state, writer).kind).toBe("spec-writer");
    });

    test("an unplanned worker that replaces a Spec Writer gets the Spec block with that writer's report", async () => {
      const state = await setup();
      const chief = await start(state);
      const writer = await delegate(state, chief.threadId, "Docs", { kind: "spec-writer" });
      await readyIdle(state, writer.threadId, "Docs done");
      await delegate(state, chief.threadId, "Build", { replaces: writer.threadId, kind: "worker" });
      expect(section(state.spawned.at(-1).prompt, "Spec")).toBe([WORKER_SPEC_RULES[0], `Spec Writer ${writer.threadId}: report ${rowOf(state, writer.threadId).report_path ?? "none"}`, ...WORKER_SPEC_RULES.slice(1)].join("\n") + "\n");
    });

    // Contract 16 (unplanned): the default kind stays worker; an explicit spec-writer is accepted with no plan, its ready alert names
    // the worker call with the unplannedReason and says not to review, a tester cannot follow it, and it never completes.
    // Regression: the unplanned default flips to spec-writer, or the writer is treated as finished work (review or complete).
    test("an unplanned Spec Writer is opt-in, hands off to a worker and is never completed", async () => {
      const state = await setup();
      const chief = await start(state);
      const plain = await delegate(state, chief.threadId, "Plain");
      expect(rowOf(state, plain.threadId).kind).toBeNull();

      const call = (extra: object) => tool(state, "chief_delegate", { title: "Docs", mission: "Update docs/specs/totals.md", unplannedReason: "Bounded", ...extra }, chief.threadId);
      await call({ kind: "spec-writer" });
      const writer = (await status(state)).threads.filter((row) => row.role === "worker").at(-1)!.threadId;
      expect(rowOf(state, writer)).toMatchObject({ kind: "spec-writer", plan_thread_id: null });
      expect(state.spawned.at(-1).prompt).toContain("Unplanned: Chief's mission is your Spec delta");
      await report(state, writer, { state: "ready", result: "Docs done" });
      expect(lastAlert(state)).toContain(`Spec Writer ${writer} committed the docs. Once it is idle, delegate the worker to implement against them: chief_delegate (replaces: ${writer}, kind: worker, unplannedReason: Bounded). Do not review yet.`);
      setLive(state, writer, "idle");
      await expect(tool(state, "chief_complete", { threadId: writer, skipReview: "docs only" }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${writer}: a Spec Writer's docs need their worker — chief_delegate (replaces: ${writer}, kind: worker).`);
      await expect(tool(state, "chief_delegate", { title: "Tests", mission: "Test it", replaces: writer, kind: "tester" }, chief.threadId)).rejects.toThrow(
        `Spec Writer ${writer} hands off to its worker: chief_delegate (replaces: ${writer}, kind: worker).`);
      expect(rowOf(state, writer).state).toBe("ready");
    });

  });
});

// Wave 8 (plan wave 6: a same-plan side-lane Spec Writer repair carries its whole known docs work list). Source of truth: the plan's
// Routes, Contracts to verify and Spec delta, and docs/specs/plan-chains.md "Spec Writer Side Lane". One plan, two chains whose Spec
// deltas name the same docs path; every case drives chief_delegate / chief_report / chief_review and reads the spawned brief.
describe("docs work list", () => {
  const OWN = { w1: "None", w2: "- W2NOTE tidy the totals rounding", w3: "- W3NOTE", w4: "- T4NOTE", w5: "- W5NOTE", w6: "- T6NOTE", s1: "- S1NOTE" };
  const repair = async (state: State, ctx: { chief: { threadId: string }; P: string }, waveNo: number, replaces: string) => {
    await swap(state, ctx.chief, ctx.P, waveNo, replaces, "spec-writer");
    return lastPrompt(state);
  };

  // Contracts 1, 2 (owned waves, tags, kinds): each chain's repair lists only its owned waves' Docs needed, tagged with thread id and wave,
  // from worker and tester rows alike, never another chain's (even on a shared docs path), a later spec wave's, a spec-writer row's or a None.
  // Regression: a plan-wide or chain-wide collection leaks another writer's items; the owned range ignores the next spec wave; a tester or
  // later-wave worker is skipped; a writer's own Docs needed is relisted; None is listed.
  test("each chain's writer repair lists only its owned waves' Docs needed, tagged with id and wave", async () => {
    const state = await setup();
    const ctx = await docsChains(state, OWN);
    const list = (prompt: string) => docsWorkList(prompt);
    const forS1 = list(await repair(state, ctx, 1, ctx.s1));
    expect(forS1).toContain("## Docs work list (wave 1)");
    expect(forS1).toContain(`${ctx.w2} (wave 2): - W2NOTE tidy the totals rounding`);
    for (const other of ["W3NOTE", "T4NOTE", "W5NOTE", "T6NOTE", "S1NOTE", ctx.w1]) expect(forS1).not.toContain(other);

    const forS3 = list(await repair(state, ctx, 3, ctx.s3));
    expect(forS3).toContain("## Docs work list (wave 3)");
    expect(forS3).toContain(`${ctx.w3} (wave 3): - W3NOTE`);
    expect(forS3).toContain(`${ctx.w4} (wave 4): - T4NOTE`);
    for (const other of ["W2NOTE", "W5NOTE", "T6NOTE", "S1NOTE"]) expect(forS3).not.toContain(other);

    const forS5 = list(await repair(state, ctx, 5, ctx.s5));
    expect(forS5).toContain("## Docs work list (wave 5)");
    expect(forS5).toContain(`${ctx.w5} (wave 5): - W5NOTE`);
    expect(forS5).toContain(`${ctx.w6} (wave 6): - T6NOTE`);
    for (const other of ["W2NOTE", "W3NOTE", "T4NOTE", "S1NOTE"]) expect(forS5).not.toContain(other);
  });

  // Contract 3 (blocker): the prior writer's blocker is listed, tagged, when its last report was blocked; the repair of that repair, once it
  // reported ready, does not carry the old blocker. Regression: the blocker is dropped, or carried down the chain after it was handled.
  test("the prior writer's blocker is listed only when it was blocked", async () => {
    const state = await setup();
    const ctx = await docsChains(state, OWN, true);
    const blocked = docsWorkList(await repair(state, ctx, 5, ctx.s5));
    expect(blocked).toContain(`${ctx.w5} (wave 5): - W5NOTE`);
    expect(blocked).toContain(`${ctx.s5} (blocker): Delta names no domain`);
    expect(blocked.indexOf("W5NOTE")).toBeLessThan(blocked.indexOf("Delta names no domain"));
    const second = writerOn(state, ctx.P, 5).thread_id as string;
    await readyIdle(state, second);
    const again = docsWorkList(await repair(state, ctx, 5, second));
    expect(again).toContain(`${ctx.w5} (wave 5): - W5NOTE`);
    expect(again).not.toContain("Delta names no domain");
    expect(again).not.toContain("(blocker)");
  });

  // Contract 3 (fix 4): chief_stop blocks a row with a synthetic "Stopped by Chief" blocker though its last report was ready, or it never reported.
  // The repair that replaces it carries no blocker line. Regression: the blocker is included whenever the row's state is blocked.
  test.each([["a writer whose last report was ready", true], ["a writer that never reported", false]])("a chief_stop synthetic blocker is not listed for %s", async (_name, reported) => {
    const state = await setup();
    const ctx = await docsChains(state, OWN);
    if (!reported) {
      const fresh = await swap(state, ctx.chief, ctx.P, 5, ctx.s5, "spec-writer");
      expect(rowOf(state, fresh).last_report_state).toBeNull();
      ctx.s5 = fresh;
    }
    setLive(state, ctx.s5, "active");
    const stopped = await state.harness.behavior.runCli(["stop", ctx.s5, "--reason", "stuck"], ctxOf(state, ctx.chief.threadId));
    expect(stopped.exitCode).toBe(0);
    expect(rowOf(state, ctx.s5)).toMatchObject({ state: "blocked" });
    expect(rowOf(state, ctx.s5).blocker).toContain("Stopped by Chief");
    const list = docsWorkList(await repair(state, ctx, 5, ctx.s5));
    expect(list).toContain(`${ctx.w5} (wave 5): - W5NOTE`);
    expect(list).not.toContain("(blocker)");
    expect(list).not.toContain("Stopped by Chief");
  });

  // The overflow line of a section, parsed: the exact omitted count and the ids it names, in order (inline form); the shown items, in order.
  const sourcesOf = (list: string) => {
    const overflow = list.match(/^(\d+) more items not shown[.,].*$/m);
    return {
      shown: [...list.matchAll(/^(thr_\w+) \((?:wave \d+|blocker)\): /gm)].map((match) => match[1]!),
      count: overflow ? Number(overflow[1]) : 0,
      line: overflow?.[0] ?? null,
      ids: overflow ? [...overflow[0].matchAll(/thr_\w+/g)].map((match) => match[0]) : [],
    };
  };
  const docsFile = (state: State, threadId: string) => join(state.storageRoot, threadId, "docs-work.md");
  const noFile = (state: State, ctx: { P: string }, waveNo: number) => expect(existsSync(docsFile(state, writerOn(state, ctx.P, waveNo).thread_id))).toBe(false);

  // Contract 4 (4,000 characters), medium cardinality: whole items in order while the section fits; the overflow line names the count and every
  // remaining source id inline. Three sources of about 2,000 characters each (worker, tester, blocker) fit one item, so two sources remain.
  // Regression: an item cut mid-text, a section over the cap, or a dropped item with no pointer.
  test("over 4,000 characters the list keeps whole items and the overflow line names every remaining source", async () => {
    const state = await setup();
    const big = (tag: string) => `- ${"a".repeat(1_950)}${tag}`;
    const ctx = await docsChains(state, { ...OWN, w5: big("END-W5"), w6: big("END-T6") }, true);
    const list = docsWorkList(await repair(state, ctx, 5, ctx.s5));
    expect(list.length).toBeLessThanOrEqual(4_000);
    expect(list).toContain(`${ctx.w5} (wave 5): ${big("END-W5")}`);
    expect(list).not.toContain("END-T6");
    const found = sourcesOf(list);
    expect(found).toMatchObject({ shown: [ctx.w5], count: 2, ids: [ctx.w6, ctx.s5] });
    expect(list.split("bb chief inspect")).toHaveLength(2);
    expect(list.split(ctx.w5)).toHaveLength(2);
    noFile(state, ctx, 5);
  });

  // Contract 4 at higher cardinality: there is no lifetime row cap, so a chain can own far more rows than the 4,000 characters hold. Clones of the
  // tester row (14-character ids, as real ones) stand for rows retained over many repairs. Inline first: the section shows the LARGEST whole-item
  // prefix that leaves room for the exact omitted count and every omitted id; a shorter prefix that fits is never traded for a pointer.
  // Regression (thr_y999sbnauy): at 150 retained rows the section took the status pointer although a shorter prefix fit inline.
  const cloneRows = async (state: State, ctx: { chief: { threadId: string }; w6: string }, count: number, text?: (n: number) => string) => {
    const cols = (state.db.prepare("PRAGMA table_info(managed_threads)").all() as { name: string }[]).map((column) => column.name);
    const insert = state.db.prepare(`INSERT INTO managed_threads (${cols.join(",")}) SELECT ${cols.map((name) => (name === "thread_id" ? "?" : name)).join(",")} FROM managed_threads WHERE thread_id=?`);
    const ids = Array.from({ length: count }, (_, n) => `thr_${String(n + 1).padStart(10, "0")}`);
    for (const id of ids) insert.run(id, ctx.w6);
    if (text) ids.forEach((id, n) => state.db.prepare(`UPDATE managed_threads SET result=? WHERE thread_id=?`).run(`${READY}\n\n## Docs needed\n${text(n + 1)}`, id));
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, ctx.chief.threadId);
    return ids;
  };

  test.each([[8, "x".repeat(600)], [150, ""]])("with %i retained rows the section keeps the largest prefix whose omitted ids fit inline, in order, within 4,000 characters", async (count, filler) => {
    const state = await setup();
    const w6 = `- T6NOTE${filler}`;
    const ctx = await docsChains(state, { ...OWN, w6 });
    const clones = await cloneRows(state, ctx, count);
    const list = docsWorkList(await repair(state, ctx, 5, ctx.s5));
    const total = [ctx.w5, ctx.w6, ...clones];
    const { shown, count: omitted, line, ids } = sourcesOf(list);
    expect(list.length).toBeLessThanOrEqual(4_000);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(total.length);
    // Order, exact omitted count, exact remaining ids.
    expect(shown).toEqual(total.slice(0, shown.length));
    expect(omitted).toBe(total.length - shown.length);
    expect(ids).toEqual(total.slice(shown.length));
    expect(list).not.toContain("bb chief status");
    expect(list).not.toContain("docs-work.md");
    noFile(state, ctx, 5);
    // Largest: one more item (and one id fewer) would put the section over the cap. The next item is a clone, as long as the first clone.
    const nextItem = `\n${total[shown.length]} (wave 6): ${w6}`;
    const nextLine = line!.replace(/^\d+/, String(omitted - 1)).replace(` ${ids[0]}`, "");
    const bigger = list.length - line!.length + (omitted > 1 ? nextLine.length : -1) + nextItem.length;
    expect(bigger).toBeGreaterThan(4_000);
  });

  // The zero-shown case: every item is too long to leave room for the ids beside it, yet the ids fit. The section shows no item, the exact count
  // and every id in order, inline, and writes no file.
  test("when no item fits beside the ids but the ids fit, the section shows no item and names every id inline", async () => {
    const state = await setup();
    const big = (tag: string) => `- ${"b".repeat(3_700)}${tag}`;
    const ctx = await docsChains(state, { ...OWN, w5: big("END-W5"), w6: big("END-T6") }, true);
    const list = docsWorkList(await repair(state, ctx, 5, ctx.s5));
    expect(list.length).toBeLessThanOrEqual(4_000);
    expect(sourcesOf(list)).toMatchObject({ shown: [], count: 3, ids: [ctx.w5, ctx.w6, ctx.s5] });
    for (const hidden of ["END-W5", "END-T6", "Delta names no domain"]) expect(list).not.toContain(hidden);
    expect(list).toContain("Fix every item that still holds");
    expect(list).not.toContain("docs-work.md");
    noFile(state, ctx, 5);
  });

  // Extreme cardinality: even the ids cannot fit. The section shows the exact omitted count and points to one file in the repair's thread storage
  // that holds every item of the owned waves in full, each once: a designer's and the blocked prior writer's among them (both outside the shown
  // prefix: the designer is the newest row, the blocker is always last). Items of other waves, other chains, a spec-writer row and a None are absent.
  // Regression (thr_y999sbnauy): the fallback pointed only at worker and tester reports, so an omitted designer item or the blocker was unreachable.
  test("when even the ids cannot fit, the section gives the exact count and a file that holds every omitted item once, designer and blocker included", async () => {
    const state = await setup();
    const blocker = `Delta names no domain. ${"why ".repeat(200)}END-BLOCKER`;
    expect(blocker.length).toBeGreaterThan(600);
    const ctx = await docsChains(state, { ...OWN, s1: "- S1NOTE" }, blocker);
    const clones = await cloneRows(state, ctx, 400, (n) => `- CLONE-${n}-END`);
    const designer = clones.at(-1)!;
    state.db.prepare(`UPDATE managed_threads SET kind='designer' WHERE thread_id=?`).run(designer);
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, ctx.chief.threadId);
    const list = docsWorkList(await repair(state, ctx, 5, ctx.s5));
    const total = [ctx.w5, ctx.w6, ...clones, ctx.s5];
    const { shown, count, line, ids } = sourcesOf(list);
    expect(list.length).toBeLessThanOrEqual(4_000);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(total.slice(0, shown.length));
    expect(shown).not.toContain(designer);
    expect(shown).not.toContain(ctx.s5);
    expect(count).toBe(total.length - shown.length);
    expect(ids).toEqual([]);
    expect(line).toContain("$BB_THREAD_STORAGE/docs-work.md");
    expect(list).not.toContain("bb chief status");

    const file = readFileSync(docsFile(state, writerOn(state, ctx.P, 5).thread_id), "utf8");
    const once = (needle: string) => expect(file.split(needle)).toHaveLength(2);
    // Every item (shown or omitted) once, with its source: the designer's, the worker's, the tester's and each clone's full text, then the whole blocker.
    once(`## ${ctx.w5}: worker, wave 5\n\n- W5NOTE\n`);
    once(`## ${ctx.w6}: worker, wave 6\n\n- T6NOTE\n`);
    once(`## ${designer}: designer, wave 6\n\n- CLONE-400-END\n`);
    clones.slice(0, -1).forEach((id, n) => once(`## ${id}: worker, wave 6\n\n- CLONE-${n + 1}-END\n`));
    once(`## ${ctx.s5}: prior writer's blocker\n\n${blocker}\n`);
    expect(file.match(/^## thr_/gm)).toHaveLength(total.length);
    expect(file).toContain("all 403 items");
    // Excluded sources: other chains' and waves' notes, the spec-writer rows' notes, a None section.
    for (const out of ["W2NOTE", "W3NOTE", "T4NOTE", "S1NOTE", ctx.w1, ctx.w2, ctx.w3, ctx.w4, ctx.s1, ctx.s3]) expect(file).not.toContain(out);
  });

  // Retest of #242 finding 1 (verdicts thr_8ikzcixq2m, thr_6q3b5ttyi8): the file is the only place the omitted items live, so a rejected write
  // (not a 409: ENOSPC, a refused host) rolls the launch back. The new thread is stopped and unlinked from the plan, so the blocked prior writer
  // stays the owner everywhere the plan decides (its writer is still owed, a chain-tip review is still refused naming it), and the chief_delegate
  // call fails with a message Chief can act on; repeating the call once storage works succeeds and transfers ownership.
  // Regression: the failed row is marked complete in the plan, so the scheduler sees the newest writer as settled and drops the blocked owner.
  const rollbackFixture = async (state: State) => {
    const blocker = `Delta names no domain. ${"why ".repeat(200)}END-BLOCKER`;
    const ctx = await docsChains(state, OWN, blocker);
    await cloneRows(state, ctx, 400, (n) => `- CLONE-${n}-END`);
    expect(rowOf(state, ctx.s5)).toMatchObject({ state: "blocked", last_report_state: "blocked" });
    // The gate before the failure: chain B's tip cannot be reviewed while its writer is owed.
    const tip = ownerOn(state, ctx.P, 6).thread_id as string;
    const gate = () => expect(tool(state, "chief_review", { workerThreadId: tip }, ctx.chief.threadId)).rejects.toThrow(new RegExp(`wave 5's ${ctx.s5} \\(`));
    await gate();
    return { ctx, gate, blocker };
  };
  const failedOf = (state: State, prior: string) => state.db.prepare(`SELECT * FROM managed_threads WHERE replaces_thread_id=?`).get(prior) as any;

  test("a rejected docs-work file write rolls the launch back: the prior writer stays the owner, the review gate stays closed, and the repeated call succeeds", async () => {
    const state = await setup();
    const { ctx, gate, blocker } = await rollbackFixture(state);

    state.failWritesMatching(/docs-work\.md/);
    const message = await refusal(delegateWave(state, ctx.chief.threadId, ctx.P, 5, { replaces: ctx.s5, kind: "spec-writer" }));
    const failed = failedOf(state, ctx.s5).thread_id as string;
    expect(failed).not.toBe(ctx.s5);
    expect(message).toContain(failed);
    expect(message).toContain("write refused");
    expect(message).toContain(`${ctx.s5} stays the owner of the docs work`);
    expect(message).toContain("Repeat this chief_delegate call");
    expect(message).not.toContain("FAILED");
    // The new thread was spawned with the pointer in its prompt, then stopped; no file exists for it.
    expect(lastPrompt(state)).toContain("$BB_THREAD_STORAGE/docs-work.md");
    expect(state.stopped).toContain(failed);
    expect(existsSync(docsFile(state, failed))).toBe(false);
    // The failed attempt leaves the plan (it stays a row for diagnostics): the plan's newest wave 5 writer is still the blocked prior, which is still owed.
    expect(rowOf(state, failed)).toMatchObject({ replaces_thread_id: ctx.s5, plan_thread_id: null, plan_wave: null, state: "complete" });
    expect(writerOn(state, ctx.P, 5).thread_id).toBe(ctx.s5);
    expect(rowOf(state, ctx.s5)).toMatchObject({ state: "blocked", last_report_state: "blocked", plan_thread_id: ctx.P, plan_wave: 5 });
    expect(state.stopped).not.toContain(ctx.s5);
    await gate();
    // A reload of the row cache (what the next write does) changes none of it.
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, ctx.chief.threadId);
    await gate();

    // Storage recovers: the same call is admitted (the stopped row no longer holds the branch), retires the prior writer and writes the full list.
    state.failWritesMatching(null);
    await delegateWave(state, ctx.chief.threadId, ctx.P, 5, { replaces: ctx.s5, kind: "spec-writer" });
    const retry = writerOn(state, ctx.P, 5).thread_id as string;
    expect(retry).not.toBe(failed);
    expect(retry).not.toBe(ctx.s5);
    expect(rowOf(state, ctx.s5).state).toBe("complete");
    expect(rowOf(state, retry)).toMatchObject({ replaces_thread_id: ctx.s5, plan_thread_id: ctx.P, plan_wave: 5 });
    expect(rowOf(state, retry).state).not.toBe("complete");
    const file = readFileSync(docsFile(state, retry), "utf8");
    expect(file).toContain("all 403 items");
    expect(file).toContain(blocker.slice(-20));
  });

  // The stop itself can fail (a host that refused both calls). The error says so instead of claiming a stop, the unconfirmed thread is not marked
  // complete (it may still run and holds the branch, so a retry cannot start a second actionable writer) and the prior writer is still the owner.
  test("when the stop also fails the error says so, the thread stays live and holds the branch, the owner and gate are unchanged, and a retry waits for the stop", async () => {
    const state = await setup();
    const { ctx, gate } = await rollbackFixture(state);

    state.failWritesMatching(/docs-work\.md/);
    state.failNextStops(1);
    const message = await refusal(delegateWave(state, ctx.chief.threadId, ctx.P, 5, { replaces: ctx.s5, kind: "spec-writer" }));
    const failed = failedOf(state, ctx.s5).thread_id as string;
    expect(message).toContain("Stopping that thread FAILED");
    expect(message).toContain("stop refused");
    expect(message).not.toContain("was stopped");
    expect(message).toContain(`${ctx.s5} stays the owner of the docs work`);
    expect(state.stopped).not.toContain(failed);
    expect(rowOf(state, failed)).toMatchObject({ plan_thread_id: null, plan_wave: null });
    expect(rowOf(state, failed).state).not.toBe("complete");
    expect(writerOn(state, ctx.P, 5).thread_id).toBe(ctx.s5);
    expect(rowOf(state, ctx.s5)).toMatchObject({ state: "blocked" });
    await gate();

    // Storage recovered, but the unconfirmed thread still holds the branch: no second actionable writer starts.
    state.failWritesMatching(null);
    const spawns = state.spawned.length;
    expect(await refusal(delegateWave(state, ctx.chief.threadId, ctx.P, 5, { replaces: ctx.s5, kind: "spec-writer" }))).toContain(`Branch ${CHAIN_B} already carries the active worker`);
    expect(state.spawned).toHaveLength(spawns);
    await gate();

    // Once that thread is gone the retry succeeds and takes the ownership.
    state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id=?`).run(failed);
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, ctx.chief.threadId);
    await delegateWave(state, ctx.chief.threadId, ctx.P, 5, { replaces: ctx.s5, kind: "spec-writer" });
    expect(writerOn(state, ctx.P, 5).thread_id).not.toBe(ctx.s5);
    expect(rowOf(state, ctx.s5).state).toBe("complete");
  });

  // The write is a prerequisite only when the file is the recovery path: a list that fits inline never touches thread storage, so a refused write
  // there changes nothing. Regression: the failure path fires for every repair, or the inline repair starts writing the file.
  test("a repair whose list fits inline never writes the file, so a refused write changes nothing", async () => {
    const state = await setup();
    const ctx = await docsChains(state, OWN, true);
    state.failWritesMatching(/docs-work\.md/);
    const list = docsWorkList(await repair(state, ctx, 5, ctx.s5));
    expect(list).toContain(`${ctx.w5} (wave 5): - W5NOTE`);
    expect(rowOf(state, ctx.s5).state).toBe("complete");
    expect(rowOf(state, writerOn(state, ctx.P, 5).thread_id).state).not.toBe("complete");
    expect(state.stopped).toEqual([]);
    noFile(state, ctx, 5);
  });

  // Contract 5 (no section elsewhere): a first writer, an implementation-lane repair, an unplanned repair, a writer adopted by a new plan, and
  // non-writer kinds get no work list even when rows hold Docs needed. Regression: the gate loses the same-plan side-lane test.
  test("no docs work list for a first writer, an implementation-lane repair, an unplanned repair, an adopted writer or a non-writer kind", async () => {
    const state = await setup();
    const ctx = await docsChains(state, OWN, true);
    expect(ctx.firstWriterPrompt).not.toContain("Docs work list");

    await delegateWave(state, ctx.chief.threadId, ctx.P, 4, { replaces: ctx.w4, kind: "spec-writer" });
    expect(lastPrompt(state)).not.toContain("Docs work list");
    const lane = writerOn(state, ctx.P, 4);
    expect(lane).toMatchObject({ replaces_thread_id: ctx.w4 });

    // The old plan's chain B ends: its tester stops holding the branch (forced, as putWriter does, then the row cache reloads).
    state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id=?`).run(ctx.w6);
    await tool(state, "chief_roster", { todo: { text: "reload the row cache" } }, ctx.chief.threadId);
    const fresh = await plan(state, ctx.chief.threadId, [specImpl(1)]);
    await delegateWave(state, ctx.chief.threadId, fresh.threadId, 1, { replaces: ctx.s5, kind: "spec-writer" });
    expect(writerOn(state, fresh.threadId, 1)).toMatchObject({ replaces_thread_id: ctx.s5 });
    expect(lastPrompt(state)).not.toContain("Docs work list");
    // The prior-attempt section still shows the blocker; only the old plan's docs items must not be collected.
    for (const old of ["W5NOTE", "T6NOTE"]) expect(lastPrompt(state)).not.toContain(old);

    const plain = await setup();
    const chief = await start(plain);
    const first = (await delegate(plain, chief.threadId, "Fix totals")).threadId;
    await readyIdle(plain, first, `${READY}\n\n## Docs needed\n- UNPLANNEDNOTE`);
    await delegate(plain, chief.threadId, "Docs", { replaces: first, kind: "spec-writer" });
    expect(lastPrompt(plain)).not.toContain("Docs work list");

    const kinds = await setup();
    const k = await docsChains(kinds, OWN);
    for (const kind of ["worker", "tester"]) {
      await swap(kinds, k.chief, k.P, 6, kinds.db.prepare(`SELECT thread_id FROM managed_threads WHERE plan_thread_id=? AND plan_wave=6 AND role='worker' ORDER BY rowid DESC`).get(k.P)!.thread_id, kind);
      expect(lastPrompt(kinds)).not.toContain("Docs work list");
      await readyIdle(kinds, workerOn(kinds, k.P, 6).thread_id);
    }
  });

  // Contract 6 (scope line): a review covering both chains gives the repair's findings section the scope line; a review of one target (an unplanned worker) does not.
  // The findings list itself is unchanged. Regression: the line is always on, never on, or follows the wrong test.
  test("the scope line is on a writer brief for the shared two-target review", async () => {
    const SCOPE = "This review covers several branches and waves. Fix only the docs findings your mission assigns to this wave";
    const shared = await setup();
    const ctx = await docsChains(shared, OWN);
    forgeAnswers({ [CHAIN_PR]: CHAIN, [CHAIN_B_PR]: CHAIN_B });
    await reviewerVerdict(shared, await openGate(shared, ctx.chief.threadId, ctx.w4), "request_changes");
    const sharedBrief = await repair(shared, ctx, 5, ctx.s5);
    expect(sharedBrief).toContain(SCOPE);
    expect(sharedBrief).toContain("Totals go negative.");
  });

  // Contract 7 (fix 2, wave 7 native design): the docs routing sentence is in the alert Chief is actually sent, once, whole and inside the retained
  // 1,200-character action, whenever the handoff emitted a Spec Writer route: a direct side-lane route, a shared route with several writers, and a
  // long shared handoff whose route list is clipped. A handoff with no writer route never gets it. The alert is read from what was delivered
  // (lastAlert), not from the roster, which is not clipped.
  // Regression: the sentence is repeated per writer, appended after the route list and clipped away, skipped on a writer route, or leaks.
  const SENTENCE = "In each Spec Writer's mission, list the docs findings that wave owns (verdict file item or file:line); a finding on a docs path several waves share goes to the wave whose Spec delta names it. The plugin attaches that wave's `## Docs needed` items.";
  const ACTION_CAP = 1_200;
  const actionOf = (text: string) => { const line = text.split("\n").find((entry) => entry.includes("The reviewer requires changes"))!; return line.slice(line.indexOf("The reviewer requires changes")); };
  const adviceOf = async (state: State, chiefThreadId: string) => actionOf(await roster(state, chiefThreadId));
  /** The note once and whole in the delivered action, which stays within the cap; returns the action. */
  const delivered = (state: State) => {
    const action = actionOf(lastAlert(state));
    expect(action.length).toBeLessThanOrEqual(ACTION_CAP);
    expect(action.split(SENTENCE)).toHaveLength(2);
    expect(lastAlert(state).split(SENTENCE)).toHaveLength(2);
    return action;
  };

  // Retest of #242 finding 2 (verdict thr_8ikzcixq2m): the delivered action must hold only whole routes within the cap, and when routes are
  // omitted say where the complete handoff is. `list` reads the " / "-joined route list between two fixed phrases of an action.
  const listOf = (action: string, from: string, to: string) => action.slice(action.indexOf(from) + from.length, action.indexOf(to)).split(" / ");
  /** What the delivered alert's action keeps of the roster's complete handoff: whole routes in order, a pointer for the rest, nothing cut. */
  const keptWhole = async (state: State, chiefThreadId: string, from: string, to: string) => {
    const action = delivered(state);
    const advice = await adviceOf(state, chiefThreadId);
    // The fixture is long: the complete handoff exceeds the cap, so the delivered action had to drop routes.
    expect(advice.length).toBeGreaterThan(ACTION_CAP);
    expect(action.indexOf(SENTENCE)).toBeLessThan(action.indexOf("chief_delegate"));
    expect(action.endsWith("…")).toBe(false);
    expect(action.endsWith("Escalate if the disagreement is a genuine decision.")).toBe(true);
    const complete = listOf(advice, from, to);
    const delivered_ = listOf(action, from, to);
    const pointer = delivered_.pop()!;
    // Whole commands: every kept route is exactly the roster's route, in order, and at least one is dropped for the pointer to be needed.
    expect(delivered_.length).toBeGreaterThan(0);
    expect(delivered_.length).toBeLessThan(complete.length);
    expect(delivered_).toEqual(complete.slice(0, delivered_.length));
    // The pointer counts the omitted routes exactly and names the tool that prints them.
    expect(pointer).toContain(`${complete.length - delivered_.length} more`);
    expect(pointer).toContain("chief_roster");
    return { advice, action };
  };

  // Contract 8 (route unchanged): the same-plan repair still gets its own fresh worktree on the chain branch, the Fold section and the trailer line.
  // Regression: carrying the list changes the worktree, drops the Fold section or the trailer rule.
  test("the repair keeps its fresh worktree from the branch, the Fold section and the trailer line", async () => {
    const state = await setup();
    const ctx = await docsChains(state, OWN);
    const before = state.live.get(ctx.s5)!.environmentId;
    const prompt = await repair(state, ctx, 5, ctx.s5);
    expect(docsWorkList(prompt)).toContain("W5NOTE");
    expect(state.spawned.at(-1).environment).toEqual({ type: "host", hostId: expect.any(String), workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: CHAIN_B } } });
    expect(state.live.get(writerOn(state, ctx.P, 5).thread_id)!.environmentId).not.toBe(before);
    expect(section(prompt, "Fold")).toBe(`Fold your docs/ commits onto ${CHAIN_B}: follow section 10 (Fold) of the \`chief-role-spec-writer\` skill with <branch> = ${CHAIN_B}, and record Fold base and Fold head.\n`);
    expect(prompt).toContain("every commit carries the trailer Chief-Spec-Writer: $BB_THREAD_ID.");
  });
});
