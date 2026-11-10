import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import { checkPlan } from "./reportIntake";
import { NOT_DOING, SPEC_DELTA, type WriterState, fullChain, lastAlert, putWriter, roster, section, skipSpecs, specImpl, specPlan, storedWave, swap, withWriter } from "./test/specWriterHelpers";
import { READY, type State, ctxOf, delegateWave, plan, planWave, planWaves, readyIdle, report, reviewed, rowOf, setLive, tool, workerOn } from "./test/testerHelpers";
import { TEST_WAVE, approvePlan, delegate, disposals, disposeAll, legacyWave, planFile, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

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
      const worker = await swap(state, chief, planner.threadId, 1, repair, "worker");
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
      const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
      expect(configuration.hosts[0]!.selections["spec-writer"]).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      expect(configuration.hosts[0]!.unusable).toEqual([]);

      await set("host_1", "spec-writer", "gpt-5-retired");
      await readyIdle(state, worker);
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
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
        const planner = await plan(state, chief.threadId, [specImpl(), TEST_WAVE(2)]);
        await delegateWave(state, chief.threadId, planner.threadId, 1);
        const writer = workerOn(state, planner.threadId, 1).thread_id as string;
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

    // Contract (checkPlan, byte-stable errors): a plan with no `spec` key gets exactly the errors it got before the flag
    // existed; the strings were captured by running checkPlan at the pre-wave-1 commit 783efcb on these inputs.
    // Regression: the spec branch reorders or rewords an old plan's errors, so a planner's retry loop sees new text.
    test("checkPlan returns byte-identical errors for plans that do not use spec", () => {
      const W = (n: number, extra: object = {}) => ({ body: `# Wave ${n}\nx\n\n## Contracts to verify\n- c${n}\n\n## What we're NOT doing\n- x`, ...extra });
      expect(checkPlan([W(1), W(2, { test: "yes" })])).toEqual([
        "plan wave 2 test is \"yes\" (string); allowed true or false. Send a boolean, or drop test.",
        "plan wave 2 ends a chain but is not test: true; follow it with a test wave (test: true, dependsOn [2]) that tests it.",
      ]);
      expect(checkPlan([W(1), W(2, { design: true, test: true })])).toEqual([
        "plan wave 2 is both design: true and test: true; a wave is one or the other.",
        "plan wave 2 is design: true but no wave builds on it; follow it with the wave that implements it (dependsOn [2] or the next wave), or drop design.",
      ]);
      expect(checkPlan([W(1), W(2, { test: true }), W(3, { test: true })])).toEqual([
        "plan wave 2 is test: true but a later wave builds on it; a test wave ends its chain.",
        "plan wave 3 is test: true but builds on test wave 2; build it on the chain's last implementation wave.",
      ]);
    });

    // Contract 1 (checkPlan, spec flag): spec is a boolean on an implementation wave whose body has a Spec delta heading; a test
    // or design wave never carries it. Regression: dropping the heading rule lets a docs step with no work list through;
    // dropping the test/design rule lets a Spec Writer be scheduled where no worker implements; dropping the copy loses the flag.
    test.each<[string, object[], RegExp[]]>([
      ["accepts spec: true on an implementation wave with a Spec delta heading", [specImpl(1), TEST_WAVE(2)], []],
      ["accepts a Spec delta heading at any level", [specImpl(1, { body: wave(1, "Build.\n\n### spec delta\n- docs/x.md") + NOT_DOING }), TEST_WAVE(2)], []],
      ["refuses a non-boolean spec", [planWave(1, { spec: "yes" }), planWave(2, { test: true })], [/plan wave 1 spec is "yes" \(string\); allowed true or false\. Send a boolean, or drop spec\./]],
      ["refuses spec: true on a test wave", [planWave(1), planWave(2, { test: true, spec: true, body: wave(2, `Tests.\n\n${SPEC_DELTA}`) })], [/plan wave 2 is spec: true and test: true; spec marks an implementation wave only\./]],
      ["refuses spec: true on a design wave", [planWave(1, { design: true, spec: true, body: wave(1, `Draw.\n\n${SPEC_DELTA}`) }), planWave(2), planWave(3, { test: true })], [/plan wave 1 is spec: true and design: true; spec marks an implementation wave only\./]],
      ["refuses spec: true with no Spec delta heading", [planWave(1, { spec: true }), planWave(2, { test: true })], [/plan wave 1 is spec: true but lacks a "## Spec delta" Markdown heading naming the docs the Spec Writer changes/]],
      ["refuses a Spec delta named only in bold text", [specImpl(1, { body: wave(1, "**Spec delta**\n- docs/x.md") + NOT_DOING }), TEST_WAVE(2)], [/plan wave 1 is spec: true but lacks a "## Spec delta"/]],
      ["accepts a Spec baseline heading on a spec wave", [specImpl(1, { body: wave(1, `Build.\n\n${SPEC_DELTA}\n\n## Spec baseline\n- docs/specs/totals.md (new): totals.ts`) + NOT_DOING }), TEST_WAVE(2)], []],
      ["accepts a Spec baseline heading at another level on a spec wave", [specImpl(1, { body: wave(1, `Build.\n\n${SPEC_DELTA}\n\n#### spec baseline\n- docs/specs/totals.md (new): totals.ts`) + NOT_DOING }), TEST_WAVE(2)], []],
      ["refuses a Spec baseline heading on a wave that is not spec: true", [planWave(1, { body: wave(1, "Build.\n\n## Spec baseline\n- docs/specs/totals.md (new): totals.ts") + NOT_DOING }), TEST_WAVE(2)], [/plan wave 1 has a "## Spec baseline" heading but is not spec: true; a baseline belongs to the spec wave that creates a new docs\/specs file\. Mark the wave spec: true, or drop the heading\./]],
      ["ignores Spec baseline in bold text on a wave that is not spec: true", [planWave(1, { body: wave(1, "Build.\n\n**Spec baseline**\n- docs/x.md") + NOT_DOING }), TEST_WAVE(2)], []],
    ])("checkPlan %s", (_name, input, expected) => {
      const errors = checkPlan(input);
      if (!expected.length) expect(errors).toEqual([]);
      for (const pattern of expected) expect(errors.join("\n")).toMatch(pattern);
    });

    test("a planner's spec flag is stored on the flagged implementation wave only", async () => {
      const state = await setup();
      const { planner } = await specPlan(state, [specImpl(1), TEST_WAVE(2), { body: wave(3), dependsOn: [] }, TEST_WAVE(4, [3])]);
      expect(JSON.parse(planWaves(state, planner.threadId)).map((entry: any) => entry.spec)).toEqual([true, undefined, undefined, undefined]);
    });

    // Contract 3 (spec-first flow): the default first call on a no-row spec wave spawns its Spec Writer; its ready alert, the
    // Pending block and the review refusal all name the worker call and neither the next wave nor the review; the worker's ready
    // then offers the test wave, and the tester's ready names the one review. Regression: dropping the readyStep/reviewBlock
    // "implement" branch offers the next wave or the review straight after the docs; keeping it for the worker too would
    // loop the hand-off.
    test("a ready Spec Writer hands off to its wave's worker before the next wave or the review", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      expect(rowOf(state, writer)).toMatchObject({ kind: "spec-writer", role: "worker", plan_wave: 1, replaces_thread_id: null });
      expect(state.spawned.at(-1).prompt).toContain("Wave 1 of 2: you run before its worker.");
      await report(state, writer, { state: "ready", result: READY });
      const implement = `Spec Writer ${writer} committed wave 1's docs. Once it is idle, delegate the wave's worker to implement against them: ${workerCall(planner.threadId, writer)}. Do not delegate the next wave or review yet.`;
      expect(lastAlert(state)).toContain(implement);
      expect(lastAlert(state)).not.toMatch(/Start the one review|delegate test wave 2|chief_skip_tests/);
      setLive(state, writer, "idle");
      expect(await roster(state, chief.threadId)).toContain(implement);
      await expect(tool(state, "chief_review", { workerThreadId: writer }, chief.threadId)).rejects.toThrow(
        `Wave 1 of 2 still owes its implementation: no review runs until its worker implements against the Spec Writer's docs — ${workerCall(planner.threadId, writer)}.`);
      expect((await status(state)).threads.filter((row) => row.role === "reviewer")).toEqual([]);

      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, worker);
      expect(lastAlert(state)).toContain(`delegate test wave 2: ${planFile(state, planner.threadId, 2)} — chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${worker}, kind: tester)`);
      expect(lastAlert(state)).not.toContain("Spec Writer");
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      expect(lastAlert(state)).toContain(`Start the one review of the whole plan now: chief_review (workerThreadId: ${tester})`);
      await reviewed(state, chief.threadId, tester, "approve");
      await tool(state, "chief_complete", { threadId: tester }, chief.threadId);
      expect(rowOf(state, tester).state).toBe("complete");
      expect(rowOf(state, planner.threadId).state).toBe("complete");
    });

    // Contract 2 (first delegation): a spec wave's first call defaults to kind spec-writer, also behind a parent wave; an explicit
    // worker, designer or tester there is refused with the Spec Writer call and chief_skip_specs, and starts nothing.
    // Regression: dropping the default spawns a plain worker with no docs; dropping the refusal lets a caller skip the Spec
    // Writer without recording why.
    test("a spec wave's first delegation defaults to its Spec Writer and refuses another kind", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [planWave(1), specImpl(2), TEST_WAVE(3)], true);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      const impl = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, impl);
      const rows = countRows(state);
      for (const kind of ["worker", "designer", "tester"]) {
        await expect(delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl, kind })).rejects.toThrow(
          `Wave 2 is marked spec: true: its Spec Writer runs before its worker — chief_delegate (planThreadId: ${planner.threadId}, wave: 2, replaces: ${impl}, kind: spec-writer). To go without, record why: ${skipCall(planner.threadId, 2)}.`);
      }
      expect(countRows(state)).toBe(rows);

      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: impl });
      expect(workerOn(state, planner.threadId, 2)).toMatchObject({ kind: "spec-writer", replaces_thread_id: impl });
      expect(countRows(state)).toBe(rows + 1);
    });

    // Contract 7 (chief_skip_specs): before any row it stores specsSkipped on that wave only, flips the default kind to worker
    // and refuses kind spec-writer; it is idempotent, and refused for a non-spec wave and once the wave has a row. Regression:
    // the flag is not stored on the wave (so the default stays spec-writer), is written to testsSkipped, or is accepted late.
    test("chief_skip_specs bypasses the Spec Writer before the first delegation only", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state);
      const before = JSON.parse(planWaves(state, planner.threadId));
      const text = await skipSpecs(state, chief.threadId, planner.threadId, "docs already describe this");
      expect(text).toBe(`Specs on wave 1 bypassed: delegate its worker — chief_delegate (planThreadId: ${planner.threadId}, wave: 1, kind: worker).`);
      const after = JSON.parse(planWaves(state, planner.threadId));
      expect(after[0]).toEqual({ ...before[0], specsSkipped: "docs already describe this" });
      expect(after[1]).toEqual(before[1]);
      const stored = planWaves(state, planner.threadId);
      expect(await skipSpecs(state, chief.threadId, planner.threadId, "another reason")).toBe(text);
      expect(planWaves(state, planner.threadId)).toBe(stored);

      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow(
        "Specs on wave 1 were bypassed (docs already describe this); no Spec Writer runs on it.");
      expect(countRows(state)).toBe(rows);
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      expect(rowOf(state, workerOn(state, planner.threadId, 1).thread_id).kind).not.toBe("spec-writer");
      expect(state.spawned.at(-1).prompt).not.toContain("you run before its worker");
      expect(await skipSpecs(state, chief.threadId, planner.threadId)).toBe("Specs on wave 1 were already bypassed.");

      await expect(skipSpecs(state, chief.threadId, planner.threadId, "r", 2)).rejects.toThrow(`Wave 2 of planner ${planner.threadId} is not a spec: true implementation wave.`);
      const plain = await plan(state, chief.threadId);
      await expect(skipSpecs(state, chief.threadId, plain.threadId)).rejects.toThrow(`Wave 1 of planner ${plain.threadId} is not a spec: true implementation wave.`);
    });

    test("chief_skip_specs is refused once the wave has a row, whatever that row is", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await expect(skipSpecs(state, chief.threadId, planner.threadId)).rejects.toThrow(
        `Wave 1 already has worker ${writer}: chief_skip_specs only bypasses a Spec Writer before the wave's first delegation. Re-plan with a fresh chief_plan instead.`);
      expect(storedWave(state, planner.threadId).specsSkipped).toBeUndefined();
    });

    // Contract 8: chief_skip_tests waives the tests alone. specsSkipped stays unset, and for the same shape of plan its reply is
    // the text base 8250f0c returned (the review call, as for any plan whose chain ends on the ready worker). Regression: the old
    // coupling that also waived the Spec Writer step comes back and writes specsSkipped, or the reply gains a spec sentence.
    test("chief_skip_tests leaves specsSkipped unset and replies as base 8250f0c did", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, worker);
      const text = await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
      expect(text).toBe(`All 2 waves are ready. Start the one review of the whole plan now: chief_review (workerThreadId: ${worker}). It covers every branch (${worker}). Complete each worker on that reviewer's approve — or, if you judge a review unnecessary, complete each of them without one: chief_complete (threadId: <each>, skipReview: your reason).`);
      expect(storedWave(state, planner.threadId, 2).testsSkipped).toBe("accepted");
      expect(storedWave(state, planner.threadId, 1)).not.toHaveProperty("specsSkipped");
      expect(storedWave(state, planner.threadId, 2)).not.toHaveProperty("specsSkipped");
    });

    const WRITER_STATES: WriterState[] = ["ready", "ready and idle", "blocked", "idle with no report", "complete"];

    // Contract 4 (state machine): while wave 1's latest row is a Spec Writer, in any state, the wave still owes its worker. The
    // next wave's delegation (with or without replaces:), replaces: the writer on another wave, and the review are refused, and
    // the wave stays pending even when the test wave that follows it is waived. Regression: a predicate that holds only while the
    // writer is ready drops the blocked, idle-unreported and complete rows out of the schedule, so the test wave starts with no
    // docs or the review opens. Plan: two chains, so the second chain's tester can probe the Pending list.
    test.each(WRITER_STATES)("a Spec Writer that is %s still owes wave 1's implementation", async (how) => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), TEST_WAVE(2), planWave(3, { dependsOn: [] }), TEST_WAVE(4, [3])], true);
      await delegateWave(state, chief.threadId, planner.threadId, 3, { branch: "feature/b" });
      const w3 = workerOn(state, planner.threadId, 3).thread_id as string;
      await readyIdle(state, w3);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a" });
      const writer = workerOn(state, planner.threadId, 1).thread_id as string;
      const t4 = await swap(state, chief, planner.threadId, 4, w3, "tester");
      await readyIdle(state, t4);
      await putWriter(state, chief.threadId, writer, how);

      const rows = countRows(state);
      const owed = `Wave 1 still owes its implementation: its Spec Writer ${writer} hands off to its worker first — ${workerCall(planner.threadId, writer)}.`;
      const refusal = (extra: object) => delegateWave(state, chief.threadId, planner.threadId, 2, { kind: "tester", ...extra });
      await expect(refusal({})).rejects.toThrow(owed);
      const readyWriter = how === "ready" || how === "ready and idle";
      await expect(refusal({ replaces: writer })).rejects.toThrow(readyWriter
        ? `Wave 1's Spec Writer ${writer} is ready: the wave's worker implements against its docs first — ${workerCall(planner.threadId, writer)}.`
        : `Wave 1's Spec Writer ${writer} has not reported ready: retry it with the fix — chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${writer}, kind: spec-writer)`);
      await expect(delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: writer, kind: "worker" })).rejects.toThrow(`Wave 1's Spec Writer ${writer}`);
      await expect(tool(state, "chief_review", { workerThreadId: writer }, chief.threadId)).rejects.toThrow(
        `Wave 1 of 4 still owes its implementation: no review runs until its worker implements against the Spec Writer's docs — ${workerCall(planner.threadId, writer)}.`);
      expect(countRows(state)).toBe(rows);
      expect((await status(state)).threads.filter((row) => row.role === "reviewer")).toEqual([]);

      // The advisor's probe: with the test wave waived the wave must still be pending, never [].
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
      await expect(tool(state, "chief_review", { workerThreadId: t4 }, chief.threadId)).rejects.toThrow("wave(s) 1 of 4 are not ready yet");
    });

    // Contract 5: a blocked or idle-unreported Spec Writer is retried by a Spec Writer only. A worker or designer there is refused
    // (nothing documents the wave yet), and the retry starts one row. Regression: the ready test is dropped from the hand-off check,
    // so a worker implements against docs the writer never reported ready.
    test.each<WriterState>(["blocked", "idle with no report"])("a Spec Writer that is %s is replaced by a Spec Writer only", async (how) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await putWriter(state, chief.threadId, writer, how);
      const rows = countRows(state);
      for (const kind of ["worker", "designer"]) {
        await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind })).rejects.toThrow(
          `Wave 1's Spec Writer ${writer} has not reported ready: retry it with the fix — chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${writer}, kind: spec-writer)`);
      }
      expect(countRows(state)).toBe(rows);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind: "spec-writer" });
      expect(workerOn(state, planner.threadId, 1)).toMatchObject({ kind: "spec-writer", replaces_thread_id: writer });
      expect(countRows(state)).toBe(rows + 1);
    });

    // Contract 6: chief_complete never finishes a Spec Writer: plain, override and skipReview all name the worker call (or the
    // tester rerun on a test wave). A test wave Chief waived is the one exception, since no rerun follows it. Regression: dropping the
    // guard lets an override complete the writer, which ends the wave with no implementation.
    const COMPLETE_PATHS = [["plain", {}], ["override", { override: "no approve" }], ["skipReview", { skipReview: "small change" }]] as const;
    test.each(COMPLETE_PATHS)("chief_complete refuses a spec wave's Spec Writer with %s", async (_label, how) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      await expect(tool(state, "chief_complete", { threadId: writer, ...how }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${writer}: a Spec Writer's docs need their worker — ${workerCall(planner.threadId, writer)}.`);
      expect(rowOf(state, writer).state).toBe("ready");
      expect(rowOf(state, planner.threadId).state).not.toBe("complete");
    });
    test.each(COMPLETE_PATHS)("chief_complete refuses a test wave's Spec Writer with %s", async (_label, how) => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const docs = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await readyIdle(state, docs);
      await expect(tool(state, "chief_complete", { threadId: docs, ...how }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${docs}: a Spec Writer's docs need a test rerun — chief_delegate (replaces: ${docs}, kind: tester).`);
      expect(rowOf(state, docs).state).toBe("ready");
    });

    test("chief_complete accepts a Spec Writer on a test wave Chief waived", async () => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const docs = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await readyIdle(state, docs);
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, chief.threadId);
      await tool(state, "chief_complete", { threadId: docs, skipReview: "docs only" }, chief.threadId);
      expect(rowOf(state, docs).state).toBe("complete");
    });

    // Contract 9 (admission): a Spec Writer starts only as the wave's first row on a spec wave (Initial) or as the replacement of
    // its wave's latest row on a spec-bearing chain (Repair). Accepted: replacing the spec wave's latest worker, the latest
    // tester, and the product-fix worker on the test wave. Regression: a Spec Writer branching from any other row, or on a chain
    // that has no Spec Writer, which would document work no wave owes.
    test("a Spec Writer repair is accepted on the latest tester and on a test-wave product fix", async () => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const rows = countRows(state);
      const afterTester = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      expect(rowOf(state, afterTester)).toMatchObject({ kind: "spec-writer", plan_wave: 2, replaces_thread_id: tester });
      await readyIdle(state, afterTester);
      const fix = await swap(state, chief, planner.threadId, 2, afterTester, "worker");
      await readyIdle(state, fix);
      const afterFix = await swap(state, chief, planner.threadId, 2, fix, "spec-writer");
      expect(rowOf(state, afterFix)).toMatchObject({ kind: "spec-writer", plan_wave: 2, replaces_thread_id: fix });
      expect(countRows(state)).toBe(rows + 3);
    });

    test("a Spec Writer repair is accepted on the spec wave's latest worker", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, worker);
      const repair = await swap(state, chief, planner.threadId, 1, worker, "spec-writer");
      expect(rowOf(state, repair)).toMatchObject({ kind: "spec-writer", plan_wave: 1, replaces_thread_id: worker });
    });

    test.each<[string, (ctx: Awaited<ReturnType<typeof fullChain>>) => Promise<{ call: object; wave: number; message: (planId: string, ctx: Awaited<ReturnType<typeof fullChain>>) => string }>]>([
      ["a replaced row that is not its wave's latest", async (ctx) => ({ call: { replaces: ctx.worker }, wave: 2, message: (planId, c) =>
        `A Spec Writer on wave 2 replaces its latest worker: chief_delegate (planThreadId: ${planId}, wave: 2, replaces: ${c.tester}, kind: spec-writer).` })],
      ["an earlier Spec Writer of the spec wave", async (ctx) => ({ call: { replaces: ctx.writer }, wave: 1, message: (planId, c) =>
        `A Spec Writer on wave 1 replaces its latest worker: chief_delegate (planThreadId: ${planId}, wave: 1, replaces: ${c.worker}, kind: spec-writer).` })],
    ])("a Spec Writer replacing %s is refused", async (_label, build) => {
      const state = await setup();
      const ctx = await fullChain(state);
      const { call, wave: waveNo, message } = await build(ctx);
      const rows = countRows(state);
      await expect(delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, waveNo, { ...call, kind: "spec-writer" })).rejects.toThrow(message(ctx.planner.threadId, ctx));
      expect(countRows(state)).toBe(rows);
    });

    test("a Spec Writer is refused on a chain with no spec, on a bypassed wave and on a design wave", async () => {
      // No spec on the chain: neither the worker's wave nor the test wave admits one.
      const state = await setup();
      const plain = await specPlan(state, [planWave(1), TEST_WAVE(2)]);
      await delegateWave(state, plain.chief.threadId, plain.planner.threadId, 1);
      const w1 = workerOn(state, plain.planner.threadId, 1).thread_id as string;
      await readyIdle(state, w1);
      const t2 = await swap(state, plain.chief, plain.planner.threadId, 2, w1, "tester");
      await readyIdle(state, t2);
      await expect(delegateWave(state, plain.chief.threadId, plain.planner.threadId, 2, { replaces: t2, kind: "spec-writer" })).rejects.toThrow("Wave 2: no spec on this chain, so no Spec Writer runs on it.");
      await expect(delegateWave(state, plain.chief.threadId, plain.planner.threadId, 1, { replaces: w1, kind: "spec-writer" })).rejects.toThrow("Wave 1: no spec on this chain, so no Spec Writer runs on it.");

      // A bypassed spec wave: the worker's wave and its test wave both refuse.
      const bypassed = await specPlan(state);
      await skipSpecs(state, bypassed.chief.threadId, bypassed.planner.threadId, "docs are unchanged");
      await delegateWave(state, bypassed.chief.threadId, bypassed.planner.threadId, 1);
      const b1 = workerOn(state, bypassed.planner.threadId, 1).thread_id as string;
      expect(rowOf(state, b1).kind).toBeNull();
      await readyIdle(state, b1);
      await expect(delegateWave(state, bypassed.chief.threadId, bypassed.planner.threadId, 1, { replaces: b1, kind: "spec-writer" })).rejects.toThrow(
        "Specs on wave 1 were bypassed (docs are unchanged); no Spec Writer runs on it.");

      // A design-only wave.
      const design = await specPlan(state, [planWave(1, { design: true }), specImpl(2), TEST_WAVE(3)], true);
      await expect(delegateWave(state, design.chief.threadId, design.planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow("Wave 1 is design-only: no Spec Writer runs on it.");
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE kind='spec-writer'`).get()).toEqual({ n: 0 });
    });

    /** What the owed-wave guard says for a Spec Writer in state `how`, for a call that names `call` as the writer's own replacement. */
    const notReadyText = (call: string) => `has not reported ready: retry it with the fix — ${call}, kind: spec-writer)`;
    const readyText = (call: string) => `is ready: the wave's worker implements against its docs first — ${call}, kind: worker).`;
    const isReady = (how: WriterState) => how === "ready" || how === "ready and idle";

    // Contract 4 + 5 (no replaces:): an owed wave admits a delegation only as its own Spec Writer's replacement. A worker or a
    // designer on a distinct branch with no replaces: is refused before anything spawns, in every writer state, so the wave
    // never loses its owed implementation to a row that did not read the docs. Regression (the review's trace): the guard runs
    // only when replaces: names a row, so a blocked, idle-unreported or complete writer's wave takes a designer or worker on
    // branch B, becomes "not owed", and implementation starts on unfinished docs.
    test.each(WRITER_STATES)("a worker or designer on its own branch with no replaces is refused while the Spec Writer is %s", async (how) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state, undefined, { branch: "feature/a" });
      await putWriter(state, chief.threadId, writer, how);
      const rows = countRows(state);
      const call = `chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${writer}`;
      for (const kind of ["worker", "designer"]) {
        await expect(delegateWave(state, chief.threadId, planner.threadId, 1, { kind, branch: "feature/b" })).rejects.toThrow(
          `Wave 1's Spec Writer ${writer} ${isReady(how) ? readyText(call) : notReadyText(call)}`);
      }
      expect(countRows(state)).toBe(rows);
      expect(workerOn(state, planner.threadId, 1).thread_id).toBe(writer);
      await expect(tool(state, "chief_review", { workerThreadId: writer }, chief.threadId)).rejects.toThrow("Wave 1 of 2 still owes its implementation");
    });

    // Contract 3 + 4: the one way past an owed wave is the ready writer's own hand-off. Worker and designer are both admitted
    // there, on the writer's branch. Regression: tightening the guard so that it also refuses the ready hand-off loops the wave.
    test.each(["worker", "designer"])("a ready Spec Writer hands off to a %s that replaces it", async (kind) => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state, undefined, { branch: "feature/a" });
      await readyIdle(state, writer);
      const rows = countRows(state);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: writer, kind });
      expect(countRows(state)).toBe(rows + 1);
      expect(workerOn(state, planner.threadId, 1)).toMatchObject({ kind: kind === "worker" ? null : kind, replaces_thread_id: writer, branch: "feature/a" });
    });

    /** Wave 1 (spec) → wave 2 (implementation on its own branch B) → wave 3 (test), every row ready and idle, then a Spec Writer
     * repair on wave 1 (replacing wave 1's worker on branch A) put into `how`. */
    async function repairedChain(state: State, how: WriterState) {
      const { chief, planner } = await specPlan(state, [specImpl(1), planWave(2), TEST_WAVE(3)], true);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { branch: "feature/a" });
      const writer = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, writer);
      const w1 = await swap(state, chief, planner.threadId, 1, writer, "worker");
      await readyIdle(state, w1);
      // Wave 2 is a legacy stacked row on its own branch B: a chain's wave 2 now replaces wave 1's worker on branch A.
      const { threadId: w2 } = await legacyWave(state, chief.threadId, planner.threadId, 2, "feature/b");
      await readyIdle(state, w2);
      const repair = await swap(state, chief, planner.threadId, 1, w1, "spec-writer");
      await putWriter(state, chief.threadId, repair, how);
      return { chief, planner, w1, w2, repair };
    }

    // Contract 4 (successors at any depth): while wave 1's repair Spec Writer is in any state, wave 2 (its direct successor, on its
    // own stacked branch) and wave 3 (the test wave behind wave 2) are refused, whatever replaces: names and whichever kind is
    // asked. Regression (the review's trace): the successor gate looks only at the wave's parent, so wave 3 replaces wave 2's
    // ready worker as a tester and starts while wave 1's docs are still owed.
    test.each(WRITER_STATES)("a spec repair on wave 1 in state %s refuses wave 2 and the later wave 3, whatever replaces: or kind", async (how) => {
      const state = await setup();
      const { chief, planner, w2, repair } = await repairedChain(state, how);
      const rows = countRows(state);
      const owedAncestor = `Wave 1 still owes its implementation: its Spec Writer ${repair} hands off to its worker first — ${workerCall(planner.threadId, repair)}.`;
      const writerCall = `chief_delegate (planThreadId: ${planner.threadId}, wave: 1, replaces: ${repair}`;
      const viaWriter = `Wave 1's Spec Writer ${repair} ${isReady(how) ? readyText(writerCall) : notReadyText(writerCall)}`;
      for (const target of [2, 3]) {
        for (const kind of ["worker", "designer", "tester"]) {
          await expect(delegateWave(state, chief.threadId, planner.threadId, target, { kind, branch: "feature/c" })).rejects.toThrow(owedAncestor);
          await expect(delegateWave(state, chief.threadId, planner.threadId, target, { kind, replaces: w2 })).rejects.toThrow(owedAncestor);
          await expect(delegateWave(state, chief.threadId, planner.threadId, target, { kind, replaces: repair })).rejects.toThrow(viaWriter);
        }
      }
      expect(countRows(state)).toBe(rows);
      expect((await status(state)).threads.filter((row) => row.planWave === 3)).toEqual([]);
    });

    // Contract 4 (control for the case above): once the repair writer is ready and hands off to its worker, the ancestor no longer
    // owes anything and wave 3 starts. Regression: an ancestor walk that never lets go strands the plan.
    test("wave 3 starts once wave 1's repair Spec Writer has handed off to its worker", async () => {
      const state = await setup();
      const { chief, planner, w2, repair } = await repairedChain(state, "ready and idle");
      const worker = await swap(state, chief, planner.threadId, 1, repair, "worker");
      await readyIdle(state, worker);
      await delegateWave(state, chief.threadId, planner.threadId, 3, { replaces: w2, kind: "tester" });
      expect(workerOn(state, planner.threadId, 3)).toMatchObject({ kind: "tester", replaces_thread_id: w2 });
    });

    /** A blocked wave-1 Spec Writer on plan P (branch A), and a fresh plan Q with `waves`. */
    async function crossPlan(state: State, how: WriterState, waves: object[] = [specImpl(1), TEST_WAVE(2)]) {
      const first = await withWriter(state, undefined, { branch: "feature/a" });
      await putWriter(state, first.chief.threadId, first.writer, how);
      const fresh = await plan(state, first.chief.threadId, waves);
      if (waves.length > 2) await approvePlan(state, first.chief.threadId, fresh.threadId);
      const recovery = `chief_delegate (planThreadId: ${first.planner.threadId}, wave: 1, replaces: ${first.writer}`;
      const refusal = `Wave 1's Spec Writer ${first.writer} ${isReady(how) ? readyText(recovery) : notReadyText(recovery)}`;
      return { ...first, fresh, refusal };
    }

    // Contract 3 + 9 (cross-plan recovery): a fresh plan's wave 1 Spec Writer replaces a blocked Spec Writer of another plan, on its
    // branch; the old writer is closed out. This is the recovery path the blocked alert names. Regression: the owed-wave guard
    // refuses every cross-plan replacement, so a writer that cannot write its delta can never be recovered.
    test("a fresh plan's wave 1 Spec Writer replaces a blocked Spec Writer of another plan", async () => {
      const state = await setup();
      const { chief, writer, fresh } = await crossPlan(state, "blocked");
      await delegateWave(state, chief.threadId, fresh.threadId, 1, { replaces: writer, kind: "spec-writer" });
      expect(workerOn(state, fresh.threadId, 1)).toMatchObject({ kind: "spec-writer", plan_wave: 1, replaces_thread_id: writer, branch: "feature/a" });
      expect(rowOf(state, writer).state).toBe("complete");
    });

    // Contract 3 + 9 (every other cross-plan or cross-wave replacement of an owed writer is refused, with the writer's path): a worker
    // or designer kind; a target that is not wave 1 of the fresh plan; and a fresh wave 1 that is not itself spec: true.
    // Regression: widening the exception past "kind spec-writer, wave 1, another plan, blocked writer".
    test.each<[string, object[], number, string, (refusal: string) => string]>([
      ["kind worker", [specImpl(1), TEST_WAVE(2)], 1, "worker", (refusal) => refusal],
      ["kind designer", [specImpl(1), TEST_WAVE(2)], 1, "designer", (refusal) => refusal],
      ["a wave that is not wave 1", [planWave(1), specImpl(2), TEST_WAVE(3)], 2, "spec-writer", (refusal) => refusal],
      ["a fresh wave 1 that is not spec: true", [planWave(1), TEST_WAVE(2)], 1, "spec-writer", () => "Wave 1: no spec on this chain, so no Spec Writer runs on it."],
    ])("a blocked Spec Writer of another plan is not replaced by %s", async (_label, waves, target, kind, message) => {
      const state = await setup();
      const { chief, writer, fresh, refusal } = await crossPlan(state, "blocked", waves);
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, fresh.threadId, target, { replaces: writer, kind })).rejects.toThrow(message(refusal));
      expect(countRows(state)).toBe(rows);
      expect(rowOf(state, writer).state).toBe("blocked");
    });

    test.each<WriterState>(["ready", "ready and idle", "idle with no report", "complete"])("a Spec Writer of another plan that is %s is not replaced by a fresh plan's wave 1 Spec Writer", async (how) => {
      const state = await setup();
      const { chief, writer, fresh, refusal } = await crossPlan(state, how);
      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, fresh.threadId, 1, { replaces: writer, kind: "spec-writer" })).rejects.toThrow(refusal);
      expect(countRows(state)).toBe(rows);
    });

    /** wave 1's worker, wave 2's tester on a plan: with a Spec Writer first (spec chain) or without (no spec). Returns the tester, blocked and idle. */
    async function blockedTester(state: State, spec: boolean) {
      const ctx = await specPlan(state, spec ? undefined : [planWave(1), TEST_WAVE(2)]);
      const { chief, planner } = ctx;
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      let head = workerOn(state, planner.threadId, 1).thread_id as string;
      await readyIdle(state, head);
      if (spec) {
        head = await swap(state, chief, planner.threadId, 1, head, "worker");
        await readyIdle(state, head);
      }
      const tester = await swap(state, chief, planner.threadId, 2, head, "tester");
      await report(state, tester, { state: "blocked", result: "Two tests fail", blocker: "Totals test fails", recommendation: "Fix the product code" });
      setLive(state, tester, "idle");
      return { ...ctx, tester };
    }

    // Contract 10 (blocked tester): on a spec-bearing chain the alert gives the tester's recommendation and the worker, spec-writer
    // and fresh-chief_plan routes; the same blocked tester on a no-spec chain gets #164's text unchanged. Regression: the
    // spec routes never reach Chief (no way to repair a wrong spec), or they leak onto a no-spec chain.
    test("a blocked tester's alert offers the spec routes on a spec-bearing chain only", async () => {
      const state = await setup();
      const { chief, planner, tester } = await blockedTester(state, true);
      const paths = [1, 2].map((n) => planFile(state, planner.threadId, n)).join(", ");
      const worker = `chief_delegate (replaces: ${tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester.`;
      const full = `Tests failed: Totals test fails. Tester's recommendation: Fix the product code. Route by cause. If the product code is wrong: ${worker} `
        + `If the spec is wrong: chief_delegate (replaces: ${tester}, kind: spec-writer) with the fix. `
        + `If the Spec delta cannot be built: start a fresh chief_plan with the plan files (${paths}), this blocked report (bb chief inspect ${tester}), branch ${rowOf(state, tester).branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${tester}. `
        + `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason).`;
      // The alert is length-capped after the three routes begin; the roster carries the whole line.
      expect(lastAlert(state)).toContain(full.slice(0, full.indexOf("with the plan files")));
      expect(await roster(state, chief.threadId)).toContain(full);

      const plain = await setup();
      const noSpec = await blockedTester(plain, false);
      expect(lastAlert(plain)).toContain(`Tests failed: Totals test fails. Delegate a fresh worker to fix the product code: chief_delegate (replaces: ${noSpec.tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester. `
        + `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${noSpec.planner.threadId}, wave: 2, reason).`);
      expect(lastAlert(plain)).not.toMatch(/spec-writer|Spec delta/);
    });

    // Contract 10 (blocked Spec Writer): the retry and fresh-chief_plan routes, never kind: worker (no docs, nothing to implement
    // against). Regression: the generic blocked text offers a worker the writer's delta never reached.
    test("a blocked Spec Writer's alert offers a retry and a fresh plan, never a worker", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await report(state, writer, { state: "blocked", result: "Cannot write the delta", blocker: "Delta names no domain", recommendation: "Re-plan" });
      const alert = lastAlert(state);
      const paths = [1, 2].map((n) => planFile(state, planner.threadId, n)).join(", ");
      const full = `Spec Writer blocked: Delta names no domain. Retry it with the fix: chief_delegate (replaces: ${writer}, kind: spec-writer). `
        + `If the Spec delta cannot be written: start a fresh chief_plan with the plan files (${paths}), this blocked report (bb chief inspect ${writer}), branch ${rowOf(state, writer).branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${writer}, kind: spec-writer.`;
      expect(alert).toContain(full.slice(0, full.indexOf("with the plan files")));
      expect(await roster(state, chief.threadId)).toContain(full);
      expect(alert).not.toContain("kind: worker");
      expect(full).not.toContain("kind: worker");
    });

    // Contract 10 (repair routing): a Spec Writer's ready report on a test wave asks for the test rerun; on the spec wave it asks
    // for the worker. Regression: the writer's hand-off alert is the same on both waves, so a docs repair on the test wave never
    // reruns the tests or a repair on the spec wave offers a review.
    test("a ready Spec Writer repair routes to a retest on a test wave and to the worker on the spec wave", async () => {
      const state = await setup();
      const { chief, planner, tester, worker } = await fullChain(state);
      const onTest = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await report(state, onTest, { state: "ready", result: READY });
      expect(lastAlert(state)).toContain(`A Spec Writer changed docs on test wave 2: rerun the tests against them — chief_delegate (replaces: ${onTest}, kind: tester) — then review. `
        + `If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason) or start the review: chief_review (workerThreadId: ${onTest}).`);
      setLive(state, onTest, "idle");
      const onSpec = await swap(state, chief, planner.threadId, 1, worker, "spec-writer");
      await report(state, onSpec, { state: "ready", result: READY });
      expect(lastAlert(state)).toContain(`Spec Writer ${onSpec} committed wave 1's docs. Once it is idle, delegate the wave's worker to implement against them: ${workerCall(planner.threadId, onSpec)}.`);
    });

    // Contract 10 (reroute and review hand-off): a stopped row's reroute and the reviewer's request_changes hand-off offer
    // kind spec-writer only on a spec-bearing chain. Regression: the docs route leaks onto no-spec chains, or is missing on spec ones.
    test("replacesCall and the reviewer hand-off offer a Spec Writer only on a spec-bearing chain", async () => {
      const stop = async (state: State, chiefThreadId: string, threadId: string) => {
        setLive(state, threadId, "active");
        const stopped = await state.harness.behavior.runCli(["stop", threadId, "--reason", "stuck"], ctxOf(state, chiefThreadId));
        expect(stopped.exitCode).toBe(0);
        return stopped.stdout as string;
      };
      const specState = await setup();
      const { chief, planner, writer, tester } = await fullChain(specState);
      expect(await stop(specState, chief.threadId, tester)).toContain(
        `chief_delegate (replaces: ${tester}, kind: worker) for a product-code fix, chief_delegate (replaces: ${tester}, kind: tester) for a test fix or chief_delegate (replaces: ${tester}, kind: spec-writer) for a docs fix`);
      const docs = await swap(specState, chief, planner.threadId, 2, tester, "spec-writer");
      expect(await stop(specState, chief.threadId, docs)).toContain(
        `chief_delegate (replaces: ${docs}, kind: tester) for a test rerun or chief_delegate (replaces: ${docs}, kind: spec-writer) for a docs fix`);
      expect(await stop(specState, chief.threadId, writer)).toContain(
        `chief_delegate (replaces: ${writer}, kind: worker) once it reported ready, or chief_delegate (replaces: ${writer}, kind: spec-writer) for a docs fix`);

      const reviewState = await setup();
      const chain = await fullChain(reviewState);
      await reviewed(reviewState, chain.chief.threadId, chain.tester, "request_changes");
      expect(lastAlert(reviewState)).toContain(`chief_delegate (replaces: ${chain.tester}, kind: spec-writer) for docs findings`);

      const plainState = await setup();
      const plain = await specPlan(plainState, [planWave(1), TEST_WAVE(2)]);
      await delegateWave(plainState, plain.chief.threadId, plain.planner.threadId, 1);
      const w1 = workerOn(plainState, plain.planner.threadId, 1).thread_id as string;
      await readyIdle(plainState, w1);
      const t2 = await swap(plainState, plain.chief, plain.planner.threadId, 2, w1, "tester");
      expect(await stop(plainState, plain.chief.threadId, t2)).toContain(
        `chief_delegate (replaces: ${t2}, kind: worker) for a product-code fix or chief_delegate (replaces: ${t2}, kind: tester) for a test fix`);
      expect(await stop(plainState, plain.chief.threadId, t2)).not.toContain("spec-writer");
      await readyIdle(plainState, t2);
      await reviewed(plainState, plain.chief.threadId, t2, "request_changes");
      expect(lastAlert(plainState)).not.toContain("spec-writer");
    });

    const BASE_HEAD = "- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start and as `Head commit: <sha>` when you report.";
    const WORKER_SPEC_RULES = [
      "Read each Spec Writer report below (`bb chief inspect <id>`), docs/INDEX.md and the specs those reports changed, and implement to match them.",
      "- Never change docs/: only a Spec Writer does.",
      "- If the spec is wrong, report blocked and recommend `chief_delegate (replaces: <your thread id>, kind: spec-writer)`. If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan.",
      BASE_HEAD,
    ];

    // Contract 11 (worker brief): every product worker on a spec-bearing chain reads the chain's Spec Writer reports from a
    // `## Spec` block and records Base/Head; the spec wave's worker and a test-wave product-fix worker both get it, and it names the
    // writer by its report path. Regression: the block is built from the replaced row only, so a fix worker on the test wave (whose
    // prior is the tester) never sees the docs it must match.
    test("a spec wave's worker and a test-wave product-fix worker get the Spec block with the chain's writer report", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withWriter(state);
      await readyIdle(state, writer);
      const worker = await swap(state, chief, planner.threadId, 1, writer, "worker");
      const specBlock = [...WORKER_SPEC_RULES.slice(0, 1), `Wave 1 Spec Writer ${writer}: report ${rowOf(state, writer).report_path ?? "none"}`, ...WORKER_SPEC_RULES.slice(1)].join("\n");
      expect(section(state.spawned.at(-1).prompt, "Spec")).toBe(specBlock + "\n");
      await readyIdle(state, worker);
      const tester = await swap(state, chief, planner.threadId, 2, worker, "tester");
      await readyIdle(state, tester);
      await swap(state, chief, planner.threadId, 2, tester, "worker");
      expect(section(state.spawned.at(-1).prompt, "Spec")).toBe(specBlock + "\n");
    });

    test("an unplanned worker that replaces a Spec Writer gets the Spec block with that writer's report", async () => {
      const state = await setup();
      const chief = await start(state);
      const writer = await delegate(state, chief.threadId, "Docs", { kind: "spec-writer" });
      await readyIdle(state, writer.threadId, "Docs done");
      await delegate(state, chief.threadId, "Build", { replaces: writer.threadId, kind: "worker" });
      expect(section(state.spawned.at(-1).prompt, "Spec")).toBe([WORKER_SPEC_RULES[0], `Spec Writer ${writer.threadId}: report ${rowOf(state, writer.threadId).report_path ?? "none"}`, ...WORKER_SPEC_RULES.slice(1)].join("\n") + "\n");
    });

    // Contract 11 (tester brief): on a spec-bearing chain the tester's source-of-truth lines are what they are with no spec
    // (plan files and contracts only); the writer reports sit in the separate `## Spec` block, with the tester's own rules.
    // Regression: spec metadata folded into the sources changes what a no-spec tester reads, or the worker's Base/Head rule
    // reaches the tester.
    test("a tester's source lines equal the no-spec form and the spec metadata sits in its own section", async () => {
      const normalize = (state: State, prompt: string) => prompt.replaceAll(state.storageRoot, "<storage>");
      const specState = await setup();
      const spec = await fullChain(specState);
      const specPrompt = normalize(specState, specState.spawned.at(-1).prompt);

      const plainState = await setup();
      const { chief, planner } = await specPlan(plainState, [specImpl(1, { spec: false }), TEST_WAVE(2)]);
      await delegateWave(plainState, chief.threadId, planner.threadId, 1);
      const w1 = workerOn(plainState, planner.threadId, 1).thread_id as string;
      await readyIdle(plainState, w1);
      await swap(plainState, chief, planner.threadId, 2, w1, "tester");
      const plainPrompt = normalize(plainState, plainState.spawned.at(-1).prompt);

      expect(section(specPrompt, "Source of truth for test cases")).toBe(section(plainPrompt, "Source of truth for test cases"));
      expect(section(specPrompt, "Source of truth for test cases")).not.toMatch(/Spec Writer/);
      expect(plainPrompt).not.toContain("## Spec\n");
      expect(section(specPrompt, "Spec")).toContain(`Wave 1 Spec Writer ${spec.writer}: report`);
      expect(section(specPrompt, "Spec")).toContain("The committed docs are the source of truth.");
      expect(section(specPrompt, "Spec")).not.toContain("Base commit");
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
