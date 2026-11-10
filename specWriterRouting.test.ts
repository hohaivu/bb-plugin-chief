import { afterEach, describe, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS } from "./src/db/migrations";
import { checkPlan } from "./src/report/reportIntake";
import { CHAIN, CHAIN_PR, NOT_DOING, SPEC_DELTA, type WriterState, delegateWriter, fullChain, lastAlert, ownerOn, putWriter, roster, section, skipSpecs, specImpl, specPlan, storedWave, swap, withBoth, withWorker, withWriter, writerOn } from "./test/specWriterHelpers";
import { READY, type State, ctxOf, delegateWave, followRoute, plan, planWave, planWaves, readyIdle, refusal, report, reviewerCount, rerunRoute, review, reviewed, rowOf, setLive, tick, tool, workerOn } from "./test/testerHelpers";
import { TEST_WAVE, approvePlan, delegate, disposals, disposeAll, latestReviewContext, legacyWave, planFile, setup, start, status, wave } from "./test/harness";
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
      await delegateWave(state, chief.threadId, planner.threadId, 1);
      const worker = ownerOn(state, planner.threadId, 1).thread_id as string;
      expect(state.spawned.at(-1)).toMatchObject({ providerId: "codex", model: "gpt-6-mini" });
      const configuration = await state.harness.behavior.callRpc("modelConfiguration", null);
      expect(configuration.hosts[0]!.selections["spec-writer"]).toMatchObject({ providerId: "codex", model: "gpt-6-astra" });
      expect(configuration.hosts[0]!.unusable).toEqual([]);

      await set("host_1", "spec-writer", "gpt-5-retired");
      await readyIdle(state, worker);
      await readyIdle(state, repair);
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


    const writerCall = (planThreadId: string, writer: string, waveNo = 1) => `chief_delegate (planThreadId: ${planThreadId}, wave: ${waveNo}, replaces: ${writer}, kind: spec-writer)`;
    const sideEnv = (branch: string) => ({ type: "host", hostId: "host_1", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: branch } } });
    const waitWriters = (waveNo: number, total: number) => new RegExp(`Wave ${waveNo} of ${total} is ready; the Spec Writer of .* is not ready yet\\. Wait for its ready report`);
    const testerCall = (planThreadId: string, waveNo: number, owner: string) => `chief_delegate (planThreadId: ${planThreadId}, wave: ${waveNo}, replaces: ${owner}, kind: tester)`;

    // Wave 1 contracts 1-4, 6, 8-10 and 16, through the real owners (admitDelegation + startWorker, readyStep + reviewBlock, markComplete,
    // forge_init): two spec waves, a feature wave and a test wave; wave 1 delegated writer-first, wave 2 worker-first, both writers live
    // at once; the workers reach the last implementation wave first. Repeated with the last writer ready (host busy) and idle+ready.
    // Regression: a writer launched in the chain worktree or the default base; the tester admitted while a writer is pending (or the
    // refusal naming no writer); readyStep offering the refused tester call; the review naming a writer, or starting early.
    test.each<["ready" | "ready and idle"]>([["ready"], ["ready and idle"]])("lifecycle: both writers beside their workers, the tester waits for the last writer (%s)", async (how) => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), specImpl(2), planWave(3), TEST_WAVE(4)], true);
      const P = planner.threadId;
      const ready = (id: string, mode: string) => (mode === "ready" ? report(state, id, { state: "ready", result: READY }) : readyIdle(state, id));

      // Wave 1, writer first: a managed worktree cut from the chain branch; the head wave's worker still starts on its own.
      const w1Writer = await delegateWriter(state, chief, P, 1);
      expect(state.spawned.at(-1).environment).toEqual(sideEnv(CHAIN));
      expect(rowOf(state, w1Writer)).toMatchObject({ kind: "spec-writer", plan_wave: 1, replaces_thread_id: null, branch: CHAIN, pr_url: CHAIN_PR });
      await expect(tool(state, "chief_forge_init", { title: "Wave 1 work", planThreadId: P, wave: 1 }, chief.threadId)).rejects.toThrow(/chain already has worker/);
      await delegateWave(state, chief.threadId, P, 1, { branch: CHAIN, prUrl: CHAIN_PR });
      const w1 = ownerOn(state, P, 1).thread_id as string;
      expect(w1).not.toBe(w1Writer);
      expect(rowOf(state, w1)).toMatchObject({ kind: null, replaces_thread_id: null });
      expect(rowOf(state, w1Writer).state).not.toBe("complete");

      // Wave 2, worker first: it replaces wave 1's owner (never its writer); its writer runs beside it on the same chain branch.
      await readyIdle(state, w1);
      await delegateWave(state, chief.threadId, P, 2, { replaces: w1 });
      const w2 = ownerOn(state, P, 2).thread_id as string;
      expect(rowOf(state, w2)).toMatchObject({ kind: null, replaces_thread_id: w1 });
      await delegateWave(state, chief.threadId, P, 2, { kind: "spec-writer" });
      const w2Writer = writerOn(state, P, 2).thread_id as string;
      expect(state.spawned.at(-1).environment).toEqual(sideEnv(rowOf(state, w1).branch));
      expect(rowOf(state, w2Writer)).toMatchObject({ kind: "spec-writer", plan_wave: 2, replaces_thread_id: null, branch: rowOf(state, w1).branch, pr_url: rowOf(state, w1).pr_url });
      expect(rowOf(state, w2)).toMatchObject({ replaces_thread_id: w1 });
      for (const live of [w1Writer, w2Writer, w2]) expect(rowOf(state, live).state).not.toBe("complete");

      // Wave 3 is admitted while both writers are pending; its ready report waits for them instead of offering a refused tester.
      await readyIdle(state, w2);
      await delegateWave(state, chief.threadId, P, 3, { replaces: w2 });
      const w3 = ownerOn(state, P, 3).thread_id as string;
      await readyIdle(state, w3);
      expect(lastAlert(state)).toMatch(waitWriters(3, 4));
      expect(lastAlert(state)).toContain(w1Writer);
      expect(lastAlert(state)).toContain(w2Writer);
      expect(lastAlert(state)).not.toContain("kind: tester");

      const rows = countRows(state);
      await expect(delegateWave(state, chief.threadId, P, 4, { replaces: w3, kind: "tester" })).rejects.toThrow(
        new RegExp(`Wave 4 is a test wave: the Tester waits for every Spec Writer of its chain\\. Wave 1's Spec Writer ${w1Writer} has not reported ready .*Wave 2's Spec Writer ${w2Writer}`));
      await expect(tool(state, "chief_review", { workerThreadId: w3 }, chief.threadId)).rejects.toThrow(/Wave 3 of 4: no review runs between waves/);
      await expect(tool(state, "chief_review", { workerThreadId: w1Writer }, chief.threadId)).rejects.toThrow(`${w1Writer} is a Spec Writer: it never starts a review.`);
      expect(countRows(state)).toBe(rows);

      // The first writer reports: the other is still pending, so no tester call yet. The last one releases the tester call.
      await ready(w1Writer, how);
      expect(lastAlert(state)).not.toContain("kind: tester");
      await expect(delegateWave(state, chief.threadId, P, 4, { replaces: w3, kind: "tester" })).rejects.toThrow(`Wave 2's Spec Writer ${w2Writer}`);
      await ready(w2Writer, how);
      const call = testerCall(P, 4, w3);
      expect(lastAlert(state)).toContain(`Delegate test wave 4: ${planFile(state, P, 4)} — ${call}`);
      setLive(state, w2Writer, "idle");
      expect(await roster(state, chief.threadId)).toContain(call);

      // The tester continues the chain's owner; the one review names an implementation tip, never a writer.
      await delegateWave(state, chief.threadId, P, 4, { replaces: w3, kind: "tester" });
      const tester = ownerOn(state, P, 4).thread_id as string;
      expect(rowOf(state, tester)).toMatchObject({ kind: "tester", replaces_thread_id: w3 });
      await readyIdle(state, tester);
      expect(lastAlert(state)).toContain(`chief_review (workerThreadId: ${tester})`);
      expect(lastAlert(state)).not.toContain(`workerThreadId: ${w1Writer}`);
      expect(lastAlert(state)).not.toContain(`workerThreadId: ${w2Writer}`);
      await reviewed(state, chief.threadId, tester, "approve");
      const context = await latestReviewContext(state);
      expect(context).toContain(w1Writer);
      expect(context).toContain(w2Writer);

      // Every row completes (the test forge cannot read the PR head, so the approve is waived by override); the plan completes with the last.
      for (const id of [w1Writer, w2Writer, tester]) {
        await tool(state, "chief_complete", { threadId: id, override: "forge head is not readable in tests" }, chief.threadId);
        expect(rowOf(state, id).state).toBe("complete");
      }
      expect(rowOf(state, P).state).toBe("complete");
    });

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

      const design = await specPlan(state, [planWave(1, { design: true }), specImpl(2), TEST_WAVE(3)]);
      await delegateWave(state, design.chief.threadId, design.planner.threadId, 1);
      expect(ownerOn(state, design.planner.threadId, 1)).toMatchObject({ kind: "designer" });
      await expect(delegateWave(state, design.chief.threadId, design.planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow("Wave 1 is design-only: no Spec Writer runs on it.");
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
      await expect(delegateWave(state, chief.threadId, P, 1, { kind: "spec-writer" })).rejects.toThrow("Specs on wave 1 were bypassed (docs already describe this); no Spec Writer runs on it.");
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
      await expect(delegateWriter(state, chief, planner.threadId)).rejects.toThrow("Specs on wave 1 were bypassed (docs are unchanged); no Spec Writer runs on it.");
    });

    test.each([["the writer alone", false], ["the writer beside its worker", true]])("chief_skip_specs is refused once the wave has a Spec Writer row: %s", async (_label, both) => {
      const state = await setup();
      const { chief, planner } = both ? await withBoth(state) : await withWriter(state);
      await expect(skipSpecs(state, chief.threadId, planner.threadId)).rejects.toThrow("chief_skip_specs only bypasses a Spec Writer that was never delegated on the wave");
      expect(storedWave(state, planner.threadId).specsSkipped).toBeUndefined();
    });

    // Wave 1 contract 15 + 10: chief_skip_tests waives the tests alone, never the writer; with the writer ready, its reply is the review call.
    test("chief_skip_tests leaves specsSkipped unset and replies with the review call", async () => {
      const state = await setup();
      const { chief, planner, worker, writer } = await withBoth(state);
      await readyIdle(state, writer);
      await readyIdle(state, worker);
      const text = await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
      expect(text).toMatch(new RegExp(`^All 2 waves are ready\\. Start the one review of the whole plan now: chief_review \\(workerThreadId: ${worker}\\)\\.`));
      expect(text).not.toContain(`workerThreadId: ${writer}`);
      expect(storedWave(state, planner.threadId, 2).testsSkipped).toBe("accepted");
      expect(storedWave(state, planner.threadId, 1)).not.toHaveProperty("specsSkipped");
    });

    const WRITER_STATES: WriterState[] = ["ready", "ready and idle", "blocked", "idle with no report", "complete"];
    const isReady = (how: WriterState) => how === "ready" || how === "ready and idle" || how === "complete";

    // Wave 1 contracts 8 and 10 (writerPending): the test wave and the plan review wait while wave 1's latest writer is not ready, not
    // idle with a ready report and not complete, whatever the writer's state; the wave stays pending even when the test wave is waived.
    // Regression: a predicate that holds only while the writer is busy lets the tester start on missing docs or the review open early.
    test.each(WRITER_STATES)("a side-lane Spec Writer that is %s: the tester and the review wait only while it is pending", async (how) => {
      const state = await setup();
      const { chief, planner, worker, writer } = await withBoth(state);
      await readyIdle(state, worker);
      await putWriter(state, chief.threadId, writer, how);
      const rows = countRows(state);
      const tester = () => delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: worker, kind: "tester" });
      if (!isReady(how)) {
        await expect(tester()).rejects.toThrow(`Wave 2 is a test wave: the Tester waits for every Spec Writer of its chain. Wave 1's Spec Writer ${writer} has not reported ready (state ${rowOf(state, writer).state}).`);
        expect(countRows(state)).toBe(rows);
        // The advisor's probe: with the test wave waived the wave must still be pending.
        await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "accepted" }, chief.threadId);
        await expect(tool(state, "chief_review", { workerThreadId: worker }, chief.threadId)).rejects.toThrow(new RegExp(`wave 1's ${writer} \\(`));
        expect((await status(state)).threads.filter((row) => row.role === "reviewer")).toEqual([]);
      } else {
        await tester();
        expect(ownerOn(state, planner.threadId, 2)).toMatchObject({ kind: "tester", replaces_thread_id: worker });
      }
    });

    // Wave 1 contract 8: later implementation waves are admitted while a writer is pending; only a test wave waits. Regression: the
    // old owed-ancestor rule comes back and gates wave 2 behind wave 1's writer.
    test("a later implementation wave is admitted while the writer of an earlier wave is pending", async () => {
      const state = await setup();
      const { chief, planner, worker, writer } = await withBoth(state, [specImpl(1), planWave(2), TEST_WAVE(3)]);
      await readyIdle(state, worker);
      await delegateWave(state, chief.threadId, planner.threadId, 2, { replaces: worker });
      expect(ownerOn(state, planner.threadId, 2)).toMatchObject({ plan_wave: 2, replaces_thread_id: worker });
      expect(rowOf(state, writer).state).not.toBe("complete");
    });

    // Wave 1 contracts 4 and 7 (holder matrix + docs repair): the side-lane writer is replaced by a writer only; the repair reuses its
    // environment and branch and completes it; every other kind is refused naming the chain's owner; a live writer is not replaced by
    // a second one. Regression: any kind may replace a writer (the worker takes over the side worktree), or the repair starts a new
    // worktree and strands the writer's checkout.
    test("a side-lane writer's docs repair reuses its worktree; every other kind is refused naming the chain's worker", async () => {
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
      expect(state.live.get(repair.thread_id)!.environmentId).toBe(environment);
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

    // Wave 1 contract 3 (first side writer): it needs the chain's branch (a mismatch is refused) and, on a later wave with no worker
    // yet, a settled chain owner; the admitted writer takes the owner's branch and PR. Regression: a writer starts a second chain on its
    // own branch, or starts beside a parent wave whose worker is still running.
    test("a first side-lane writer needs the chain's branch and a ready parent wave", async () => {
      const state = await setup();
      const { chief, planner, worker } = await withWorker(state, [specImpl(1), specImpl(2), TEST_WAVE(3)]);
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

    // An implementation-lane Spec Writer (one that replaced a tester) keeps the refusal on every path, with today's text.
    const COMPLETE_PATHS = [["plain", {}], ["override", { override: "no approve" }], ["skipReview", { skipReview: "small change" }]] as const;
    test.each(COMPLETE_PATHS)("chief_complete refuses a test wave's implementation-lane Spec Writer with %s", async (_label, how) => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const docs = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await readyIdle(state, docs);
      await expect(tool(state, "chief_complete", { threadId: docs, ...how }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${docs}: a Spec Writer's docs need a test rerun — chief_delegate (replaces: ${docs}, kind: tester).`);
      expect(rowOf(state, docs).state).toBe("ready");
    });

    test("chief_complete accepts an implementation-lane Spec Writer on a test wave Chief waived", async () => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const docs = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await readyIdle(state, docs);
      await tool(state, "chief_skip_tests", { planThreadId: planner.threadId, wave: 2, reason: "docs only" }, chief.threadId);
      await tool(state, "chief_complete", { threadId: docs, skipReview: "docs only" }, chief.threadId);
      expect(rowOf(state, docs).state).toBe("complete");
    });

    // Wave 1 contract 9/10 (admission of repairs): an implementation-lane Spec Writer repair is accepted on the latest tester and on a
    // test-wave product fix; a replaced row that is not the wave's latest owner is refused. Regression: a writer branching from any row.
    test("an implementation-lane Spec Writer repair is accepted on the latest tester and on a test-wave product fix", async () => {
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

    test("an implementation-lane Spec Writer replacing a row that is not its wave's latest is refused", async () => {
      const state = await setup();
      const ctx = await fullChain(state);
      const rows = countRows(state);
      await expect(delegateWave(state, ctx.chief.threadId, ctx.planner.threadId, 2, { replaces: ctx.worker, kind: "spec-writer" })).rejects.toThrow(
        `A Spec Writer on wave 2 replaces its latest worker: chief_delegate (planThreadId: ${ctx.planner.threadId}, wave: 2, replaces: ${ctx.tester}, kind: spec-writer).`);
      expect(countRows(state)).toBe(rows);
    });

    test("a Spec Writer is refused on a chain with no spec, on a bypassed wave and on a design wave", async () => {
      const state = await setup();
      const plain = await specPlan(state, [planWave(1), TEST_WAVE(2)]);
      await delegateWave(state, plain.chief.threadId, plain.planner.threadId, 1);
      const w1 = workerOn(state, plain.planner.threadId, 1).thread_id as string;
      await readyIdle(state, w1);
      const t2 = await swap(state, plain.chief, plain.planner.threadId, 2, w1, "tester");
      await readyIdle(state, t2);
      await expect(delegateWave(state, plain.chief.threadId, plain.planner.threadId, 2, { replaces: t2, kind: "spec-writer" })).rejects.toThrow("Wave 2: no spec on this chain, so no Spec Writer runs on it.");
      await expect(delegateWave(state, plain.chief.threadId, plain.planner.threadId, 1, { replaces: w1, kind: "spec-writer" })).rejects.toThrow("Wave 1: no spec on this chain, so no Spec Writer runs on it.");

      const bypassed = await specPlan(state);
      await skipSpecs(state, bypassed.chief.threadId, bypassed.planner.threadId, "docs are unchanged");
      await delegateWave(state, bypassed.chief.threadId, bypassed.planner.threadId, 1);
      const b1 = workerOn(state, bypassed.planner.threadId, 1).thread_id as string;
      expect(rowOf(state, b1).kind).toBeNull();
      await readyIdle(state, b1);
      await expect(delegateWave(state, bypassed.chief.threadId, bypassed.planner.threadId, 1, { replaces: b1, kind: "spec-writer" })).rejects.toThrow(
        "Specs on wave 1 were bypassed (docs are unchanged); no Spec Writer runs on it.");
      // A bypassed wave is never pending: its tester starts with no writer row.
      const t = await swap(state, bypassed.chief, bypassed.planner.threadId, 2, b1, "tester");
      expect(rowOf(state, t).state).not.toBe("complete");

      const design = await specPlan(state, [planWave(1, { design: true }), specImpl(2), TEST_WAVE(3)]);
      await expect(delegateWave(state, design.chief.threadId, design.planner.threadId, 1, { kind: "spec-writer" })).rejects.toThrow("Wave 1 is design-only: no Spec Writer runs on it.");
      expect(state.db.prepare(`SELECT COUNT(*) AS n FROM managed_threads WHERE kind='spec-writer'`).get()).toEqual({ n: 0 });
    });

    // Wave 1 contract 13 (legacy data), through the real owners: S1→W1→S2→W2 with S2 complete makes no wave pending (the tester is
    // admitted and the review runs); a ready legacy head S1 with no worker is replaced by a worker or designer; a ready legacy S2 that
    // replaced W1 is handed off as the implementation row and keeps the implementation-lane completion refusal.
    // Regression: the writer-pending rule reads the old sequential shape as pending (stranding finished chains), the legacy head can
    // no longer reach its worker, or a legacy implementation-lane writer is treated as a side-lane one.
    test("a completed legacy S1→W1→S2→W2 chain has no pending writer: tester admitted, review runs, rows complete", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), specImpl(2), TEST_WAVE(3)], true);
      const P = planner.threadId;
      const s1 = await legacyRow(state, chief.threadId, P, 1, "spec-writer", null, "feature/legacy");
      const w1 = await legacyRow(state, chief.threadId, P, 1, null, s1, "feature/legacy");
      const s2 = await legacyRow(state, chief.threadId, P, 2, "spec-writer", w1, "feature/legacy");
      const w2 = await legacyRow(state, chief.threadId, P, 2, null, s2, "feature/legacy");
      for (const id of [s1, w1, s2]) state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id=?`).run(id);
      await readyIdle(state, w2);
      expect(lastAlert(state)).not.toMatch(waitWriters(2, 3));
      await delegateWave(state, chief.threadId, P, 3, { replaces: w2, kind: "tester" });
      const tester = ownerOn(state, P, 3).thread_id as string;
      expect(rowOf(state, tester)).toMatchObject({ kind: "tester", replaces_thread_id: w2 });
      await readyIdle(state, tester);
      expect(lastAlert(state)).toContain(`chief_review (workerThreadId: ${tester})`);
      await reviewed(state, chief.threadId, tester, "approve");
      await tool(state, "chief_complete", { threadId: tester }, chief.threadId);
      expect(rowOf(state, tester).state).toBe("complete");
    });

    test.each(["worker", "designer"])("a ready legacy head Spec Writer with no worker is replaced by a %s", async (kind) => {
      const state = await setup();
      const { chief, planner } = await specPlan(state);
      const s1 = await legacyRow(state, chief.threadId, planner.threadId, 1, "spec-writer", null, "feature/legacy");
      await readyIdle(state, s1);
      await delegateWave(state, chief.threadId, planner.threadId, 1, { replaces: s1, kind });
      expect(ownerOn(state, planner.threadId, 1)).toMatchObject({ kind: kind === "worker" ? null : kind, replaces_thread_id: s1, branch: "feature/legacy" });
    });

    test("a ready legacy S2 that replaced W1 is handed off as the implementation row and is never completed by itself", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), specImpl(2), TEST_WAVE(3)], true);
      const P = planner.threadId;
      const s1 = await legacyRow(state, chief.threadId, P, 1, "spec-writer", null, "feature/legacy");
      const w1 = await legacyRow(state, chief.threadId, P, 1, null, s1, "feature/legacy");
      const s2 = await legacyRow(state, chief.threadId, P, 2, "spec-writer", w1, "feature/legacy");
      state.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id IN (?, ?)`).run(s1, w1);
      await readyIdle(state, s2);
      await expect(tool(state, "chief_complete", { threadId: s2, skipReview: "docs only" }, chief.threadId)).rejects.toThrow(
        `Refusing to complete ${s2}: a Spec Writer's docs need their worker — chief_delegate (planThreadId: ${P}, wave: 2, replaces: ${s2}, kind: worker).`);
      await delegateWave(state, chief.threadId, P, 2, { replaces: s2, kind: "worker" });
      expect(ownerOn(state, P, 2)).toMatchObject({ kind: null, replaces_thread_id: s2 });
    });

    /** A blocked wave-1 side-lane writer on plan P (branch A) and a fresh plan Q with `waves`. */
    async function crossPlan(state: State, how: WriterState, waves: object[] = [specImpl(1), TEST_WAVE(2)]) {
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
      ["kind worker", [specImpl(1), TEST_WAVE(2)], 1, "worker", (planId, writer) => sideOnly(planId, writer) as any],
      ["kind designer", [specImpl(1), TEST_WAVE(2)], 1, "designer", (planId, writer) => sideOnly(planId, writer) as any],
      ["a fresh wave 1 that is not spec: true", [planWave(1), TEST_WAVE(2)], 1, "spec-writer", () => "Wave 1: no spec on this chain, so no Spec Writer runs on it."],
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
      const ctx = await specPlan(state, spec ? undefined : [planWave(1), TEST_WAVE(2)]);
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

    // Wave 1 contract 16 (blocked tester): the alert gives the tester's recommendation and the worker, spec-writer and fresh-chief_plan
    // routes on a spec-bearing chain; the same blocked tester on a no-spec chain gets #164's text unchanged.
    test("a blocked tester's alert offers the spec routes on a spec-bearing chain only", async () => {
      const state = await setup();
      const { chief, planner, tester } = await blockedTester(state, true);
      const paths = [1, 2].map((n) => planFile(state, planner.threadId, n)).join(", ");
      const worker = `chief_delegate (replaces: ${tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester.`;
      const full = `Tests failed: Totals test fails. Tester's recommendation: Fix the product code. Route by cause. If the product code is wrong: ${worker} `
        + `If the spec is wrong: chief_delegate (replaces: ${tester}, kind: spec-writer) with the fix. `
        + `If the Spec delta cannot be built: start a fresh chief_plan with the plan files (${paths}), this blocked report (bb chief inspect ${tester}), branch ${rowOf(state, tester).branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${tester}. `
        + `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason).`;
      expect(lastAlert(state)).toContain(full.slice(0, full.indexOf("with the plan files")));
      expect(await roster(state, chief.threadId)).toContain(full);

      const plain = await setup();
      const noSpec = await blockedTester(plain, false);
      expect(lastAlert(plain)).toContain(`Tests failed: Totals test fails. Delegate a fresh worker to fix the product code: chief_delegate (replaces: ${noSpec.tester}, kind: worker) with the failures as its mission; its ready alert then asks for a tester. `
        + `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${noSpec.planner.threadId}, wave: 2, reason).`);
      expect(lastAlert(plain)).not.toMatch(/spec-writer|Spec delta/);
    });

    // Wave 1 contract 16 (blocked side-lane writer): the retry route (a fold conflict takes it too) and the fresh-plan route, never a worker.
    test("a blocked side-lane Spec Writer's alert offers a retry and a fresh plan, never a worker", async () => {
      const state = await setup();
      const { chief, planner, writer } = await withBoth(state);
      await report(state, writer, { state: "blocked", result: "Cannot write the delta", blocker: "Delta names no domain", recommendation: "Re-plan" });
      const alert = lastAlert(state);
      const paths = [1, 2].map((n) => planFile(state, planner.threadId, n)).join(", ");
      const full = `Spec Writer blocked: Delta names no domain. Retry it with the fix: chief_delegate (replaces: ${writer}, kind: spec-writer); a docs/ fold conflict on the branch takes the same route. `
        + `If the Spec delta cannot be written: start a fresh chief_plan with the plan files (${paths}), this blocked report (bb chief inspect ${writer}), branch ${rowOf(state, writer).branch ?? "none"} and the done work in context, then delegate its wave 1 with replaces: ${writer}, kind: spec-writer.`;
      expect(alert).toContain(full.slice(0, full.indexOf("with the plan files")));
      expect(await roster(state, chief.threadId)).toContain(full);
      expect(alert).not.toContain("kind: worker");
      expect(full).not.toContain("kind: worker");
    });

    // Wave 1 contract 16 (ready routing): a ready implementation-lane writer on a test wave asks for the rerun; a ready side-lane writer
    // offers no worker hand-off and no review call of its own.
    test("a ready Spec Writer routes to a retest on a test wave and never offers a worker hand-off on the spec wave", async () => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      const onTest = await swap(state, chief, planner.threadId, 2, tester, "spec-writer");
      await report(state, onTest, { state: "ready", result: READY });
      expect(lastAlert(state)).toContain(`A Spec Writer changed docs on test wave 2: rerun the tests against them — chief_delegate (replaces: ${onTest}, kind: tester) — then review. `
        + `If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${planner.threadId}, wave: 2, reason) or start the review: chief_review (workerThreadId: ${onTest}).`);

      const parallel = await setup();
      const spec = await withBoth(parallel);
      await report(parallel, spec.writer, { state: "ready", result: READY });
      expect(lastAlert(parallel)).not.toMatch(/before its worker|replaces: .*, kind: worker|implement against them/);
      expect(lastAlert(parallel)).not.toContain(`chief_review (workerThreadId: ${spec.writer})`);
    });

    // Wave 1 contract 12 + 16 (reroute and hand-off): a stopped row's reroute and the reviewer's request_changes hand-off. A side
    // writer offers only the docs replacement; an implementation row offers product and test handoffs, and its docs findings name the
    // wave's side writer; no spec-writer offer on a no-spec chain.
    test("replacesCall and the reviewer hand-off route docs findings to the side writer only", async () => {
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
      const sideStop = await stop(specState, chief.threadId, writer);
      expect(sideStop).toContain(`chief_delegate (replaces: ${writer}, kind: spec-writer) for a docs fix`);
      expect(sideStop).not.toContain(`replaces: ${writer}, kind: worker`);
      expect(sideStop).not.toContain(`replaces: ${writer}, kind: tester`);

      const reviewState = await setup();
      const chain = await fullChain(reviewState);
      await reviewed(reviewState, chain.chief.threadId, chain.tester, "request_changes");
      const handoff = lastAlert(reviewState);
      expect(handoff).toContain(`chief_delegate (replaces: ${chain.writer}, kind: spec-writer) for docs findings`);
      expect(handoff).toContain(`chief_delegate (replaces: ${chain.tester}, kind: worker) for product-code findings, chief_delegate (replaces: ${chain.tester}, kind: tester) for test-only findings`);
      // The side writer is a target of its own and takes docs findings only; the test wave has no side writer of its own, but docs findings still go to
      // its chain's writer: the tester is never offered the docs replacement (it would take over the tester's checkout instead of repairing the side worktree).
      expect(handoff).not.toContain(`replaces: ${chain.writer}, kind: worker`);
      expect(handoff).not.toContain(`replaces: ${chain.writer}, kind: tester`);
      expect(handoff).not.toContain(`replaces: ${chain.tester}, kind: spec-writer`);
      expect(handoff).not.toContain(`replaces: ${chain.worker}, kind: spec-writer`);

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

    let legacySeed = 0;
    const legacyRow = async (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, kind: string | null, replaces: string | null, branch: string) => {
      // The CLI refuses a second live row on one branch, so each row is seeded on its own and then moved onto the chain's branch.
      const { threadId } = await legacyWave(state, chiefThreadId, planThreadId, waveNo, `${branch}-seed-${(legacySeed += 1)}`);
      state.db.prepare(`UPDATE managed_threads SET kind=?, replaces_thread_id=?, branch=? WHERE thread_id=?`).run(kind, replaces, branch, threadId);
      return threadId;
    };
    // Wave 1 contract 12 (docs findings on an implementation tip): with several side writers on the chain each is named with its wave, and the
    // tester is never offered the docs replacement; a chain with no side writer (spec waiver) keeps the implementation-lane fallback.
    // Regression: docs findings routed to the tester or worker beside live side writers, one writer's wave dropped, or the fallback lost.
    test("docs findings name each of the chain's side writers by wave and never the tester; a chain without a side writer falls back to its tip", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), specImpl(2), TEST_WAVE(3)], true);
      const P = planner.threadId;
      const s1 = await delegateWriter(state, chief, P, 1);
      await delegateWave(state, chief.threadId, P, 1, { branch: CHAIN, prUrl: CHAIN_PR });
      const w1 = ownerOn(state, P, 1).thread_id as string;
      await readyIdle(state, w1);
      await delegateWave(state, chief.threadId, P, 2, { replaces: w1 });
      const w2 = ownerOn(state, P, 2).thread_id as string;
      const s2 = await delegateWriter(state, chief, P, 2);
      for (const id of [s1, s2, w2]) await readyIdle(state, id);
      const tester = await swap(state, chief, P, 3, w2, "tester");
      await readyIdle(state, tester);
      await reviewed(state, chief.threadId, tester, "request_changes");
      const advice = (await roster(state, chief.threadId)).split("\n").find((line) => line.includes("The reviewer requires changes"))!;
      expect(advice).toContain(`chief_delegate (replaces: ${s1}, kind: spec-writer) for wave 1 docs findings or chief_delegate (replaces: ${s2}, kind: spec-writer) for wave 2 docs findings`);
      expect(advice).toContain(`replaces: ${tester}, kind: worker) for product-code findings`);
      for (const owner of [tester, w2, w1]) expect(advice).not.toContain(`replaces: ${owner}, kind: spec-writer`);

      // Legacy shape with no side-lane writer (plain wave 1's W1, then wave 2's Spec Writer that replaced W1 = implementation lane, then W2): docs findings keep the implementation-lane fallback, the tester.
      const legacy = await setup();
      const lp = await specPlan(legacy, [planWave(1), specImpl(2), TEST_WAVE(3)], true);
      const LP = lp.planner.threadId;
      const lw1 = await legacyRow(legacy, lp.chief.threadId, LP, 1, null, null, "feature/legacy");
      const l2 = await legacyRow(legacy, lp.chief.threadId, LP, 2, "spec-writer", lw1, "feature/legacy");
      const lw2 = await legacyRow(legacy, lp.chief.threadId, LP, 2, null, l2, "feature/legacy");
      for (const id of [lw1, l2]) legacy.db.prepare(`UPDATE managed_threads SET state='complete' WHERE thread_id=?`).run(id);
      await readyIdle(legacy, lw2);
      await delegateWave(legacy, lp.chief.threadId, LP, 3, { replaces: lw2, kind: "tester" });
      const lt = ownerOn(legacy, LP, 3).thread_id as string;
      await readyIdle(legacy, lt);
      await reviewed(legacy, lp.chief.threadId, lt, "request_changes");
      const legacyAdvice = (await roster(legacy, lp.chief.threadId)).split("\n").find((line) => line.includes("The reviewer requires changes"))!;
      expect(legacyAdvice).toContain(`or chief_delegate (replaces: ${lt}, kind: spec-writer) for docs findings`);
      for (const done of [lw1, l2]) expect(legacyAdvice).not.toContain(`replaces: ${done}`);
    });

    // Wave 1 contracts 12/13 (legacy S1→W1→S2→W2→T, built from real handoffs, no seeded rows): the sequential handoffs pass one environment E down the
    // chain and complete S1, so S1 no longer owns a private side worktree. Docs findings on T therefore route to the implementation tip (T), never the
    // retired S1/W1/S2/W2; following that route reuses E as an implementation-lane repair, and its ready report asks for the tester rerun.
    // Regression: the docs route resurrects completed legacy head S1, whose replacement is admitted as a side writer yet launches inside T's checkout.
    test("legacy S1→W1→S2→W2→T: docs findings route to the tip T, reuse its environment and hand back to a tester rerun, never to retired S1", async () => {
      const state = await setup();
      const { chief, planner } = await specPlan(state, [specImpl(1), TEST_WAVE(2)]);
      const P = planner.threadId;
      const chain: string[] = [];
      for (const [kind, replaces] of [["spec-writer", undefined], ["worker", "s"], ["spec-writer", "s"], ["worker", "s"]] as const) {
        const prev = chain.at(-1);
        await delegateWave(state, chief.threadId, P, 1, { kind, ...(replaces && { replaces: prev }), ...(!prev && { branch: "feature/legacy" }) });
        chain.push(workerOn(state, P, 1).thread_id as string);
        await readyIdle(state, chain.at(-1)!);
      }
      const [s1, w1, s2, w2] = chain;
      await delegateWave(state, chief.threadId, P, 2, { replaces: w2, kind: "tester" });
      const T = workerOn(state, P, 2).thread_id as string;
      await readyIdle(state, T);
      const E = state.live.get(T)!.environmentId;
      for (const id of [s1, w1, s2, w2]) {
        expect(rowOf(state, id).state).toBe("complete");
        expect(state.live.get(id)!.environmentId).toBe(E);
      }

      await reviewed(state, chief.threadId, T, "request_changes");
      const advice = (await roster(state, chief.threadId)).split("\n").find((line) => line.includes("The reviewer requires changes"))!;
      for (const text of [advice, lastAlert(state)]) {
        expect(text).toContain(`replaces: ${T}, kind: spec-writer`);
        for (const retired of [s1, w1, s2, w2]) expect(text).not.toContain(`replaces: ${retired}`);
      }

      const spawns = state.spawned.length;
      await tool(state, "chief_delegate", { replaces: T, kind: "spec-writer", title: "Docs fix", mission: "Repair docs findings" }, chief.threadId);
      expect(state.spawned.length).toBe(spawns + 1);
      expect(state.spawned.at(-1).environment).toEqual({ type: "reuse", environmentId: E });
      const docs = workerOn(state, P, 2);
      expect(docs).toMatchObject({ kind: "spec-writer", replaces_thread_id: T, plan_wave: 2, branch: rowOf(state, T).branch, pr_url: rowOf(state, T).pr_url });
      expect(docs.thread_id).not.toBe(T);
      expect(rowOf(state, T).state).toBe("complete");

      await report(state, docs.thread_id, { state: "ready", result: READY });
      expect(lastAlert(state)).toContain(`chief_delegate (replaces: ${docs.thread_id}, kind: tester)`);
      setLive(state, docs.thread_id, "idle");
      await delegateWave(state, chief.threadId, P, 2, { replaces: docs.thread_id, kind: "tester" });
      expect(state.spawned.at(-1).environment).toEqual({ type: "reuse", environmentId: E });
      expect(workerOn(state, P, 2)).toMatchObject({ kind: "tester", replaces_thread_id: docs.thread_id });
    });

    // Wave 1 contract 11 (fixRound): a side writer never builds on an implementation row, so it is loose beside a same-branch tester
    // and the alert asks for one fix per branch, never a stack. A real legacy stack (waves on branches of their own) stays a stack and
    // the side writer stays loose beside it. Regression: the side writer joins its chain's stack, or the stack stops being one.
    test("a side writer and a same-branch tester are repaired per branch, not stacked; a legacy stack stays a stack beside a side writer", async () => {
      const state = await setup();
      const { chief, writer, tester } = await fullChain(state);
      await reviewed(state, chief.threadId, tester, "request_changes");
      const alert = lastAlert(state);
      expect(alert).toContain("Hand the fixes to fresh workers in this turn, one per branch the findings name:");
      expect(alert).toContain(`replaces: ${tester}, kind: worker`);
      expect(alert).toContain(`replaces: ${writer}, kind: spec-writer`);
      expect(alert).not.toMatch(/are stacked|never in parallel/);

      const legacy = await setup();
      const { chief: lc, planner: lp } = await specPlan(legacy, [specImpl(1), planWave(2), TEST_WAVE(3)]);
      await delegateWave(legacy, lc.threadId, lp.threadId, 1, { branch: CHAIN, prUrl: CHAIN_PR });
      const w1 = ownerOn(legacy, lp.threadId, 1).thread_id as string;
      const side = await delegateWriter(legacy, lc, lp.threadId, 1);
      await readyIdle(legacy, w1);
      await readyIdle(legacy, side);
      await tool(legacy, "chief_skip_tests", { planThreadId: lp.threadId, wave: 3, reason: "docs only" }, lc.threadId);
      const w2 = (await legacyWave(legacy, lc.threadId, lp.threadId, 2, "feature/b")).threadId;
      await readyIdle(legacy, w2);
      await reviewed(legacy, lc.threadId, w2, "request_changes");
      const stacked = lastAlert(legacy);
      expect(stacked).toContain(`Waves 1 → 2 are stacked, each on the one before: fix them in wave order, never in parallel.`);
      expect(stacked).toContain(`wave 1: ${w1}, wave 2: ${w2}`);
      expect(stacked).not.toContain(`wave 1: ${side}`);
      // The alert clips its tail; the roster's Pending line carries the whole advice.
      const pending = (await roster(legacy, lc.threadId)).split("\n").find((line) => line.includes("The reviewer requires changes"))!;
      expect(pending).toContain("Hand the fixes on the other branches the findings name to fresh workers in this turn:");
      expect(pending).toContain(`replaces: ${side}, kind: spec-writer`);
    });

    // Wave 1 contract 11 (rejection counts and consult routing are per target): a carried streak applies to the side writer's own
    // chain and to the tester's, each named by its own id. Regression: the side writer's chain escapes the ladder or is named as the tester.
    test.each([[2, "consult"], [3, "stop"]] as const)("a streak of %i puts the side writer and the tester each on the %s rung", async (streak, rung) => {
      const state = await setup();
      const { chief, writer, tester } = await fullChain(state);
      await tool(state, "chief_review", { workerThreadId: tester }, chief.threadId);
      const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer" && row.state !== "complete").at(-1)!.threadId;
      state.db.prepare(`UPDATE managed_threads SET reject_streak=? WHERE thread_id=?`).run(streak - 1, reviewer);
      await report(state, reviewer, { state: "ready", result: "again", verdict: "request_changes", findings: [{ file: "totals.ts", line: 3, severity: "blocking", message: "m", fix: "f" }] });
      const alert = lastAlert(state);
      if (rung === "consult") expect(alert).toContain(`Call chief_consult (workerThreadId: ${tester}) now, before any further delegation, with every branch of the review (${tester}, ${writer}) in its context`);
      else expect(alert).toContain("Stop: start no new worker. Escalate to the user");
      for (const [prior, kind] of [[writer, "spec-writer"], [tester, "worker"]] as const) {
        await expect(tool(state, "chief_delegate", { title: "Fix", mission: "Fix it", replaces: prior, kind }, chief.threadId)).rejects.toThrow(
          rung === "consult" ? `Call chief_consult (workerThreadId: ${prior})` : `escalate to the user with both positions`);
      }
    });

    const BASE_HEAD = "- Record `git rev-parse HEAD` as `Base commit: <sha>` when you start and as `Head commit: <sha>` when you report.";
    const localSync = (branch: string) => `Before you read any file, sync this checkout with ${branch}: require a clean tree (\`git status --porcelain\` prints nothing), run \`git fetch origin ${branch}\` then \`git merge --ff-only origin/${branch}\`, and record \`Local sync: <sha>\` (\`git rev-parse HEAD\`). If the tree is not clean or the fast-forward fails, report blocked. Never use autostash, never force, never touch another worktree.`;
    const rejectedPush = (branch: string) => `If that push is rejected because ${branch} moved, run \`git fetch origin ${branch}\` then \`git rebase --no-autostash origin/${branch}\` on a clean tree and push again; never force-push.`;
    const BLOCKED_PLAN = "- If the Spec delta cannot be built, report blocked and recommend a fresh chief_plan.";
    const WORKER_SPEC_RULES = [
      "Read each Spec Writer report below (`bb chief inspect <id>`), docs/INDEX.md and the specs those reports changed, and implement to match them.",
      "- Never change docs/: only a Spec Writer does.",
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
        "- Never change docs/: only a Spec Writer does.",
        BLOCKED_PLAN,
        BASE_HEAD,
      ].join("\n") + "\n");
      expect(section(prompt, "Git workflow")).toContain(localSync(CHAIN));
      expect(section(prompt, "Git workflow")).toContain(rejectedPush(CHAIN));
      expect(prompt).not.toMatch(/implement to match them|kind: spec-writer|you run before its worker/);
    });

    // Wave 2 contracts 1 and 5 (side-lane writer prompt): the rendered prompt carries the whole fold protocol as numbered steps and
    // the docs-only diff against the fetched U, a plain push to the chain branch, and the Fold base/head/none record; none of the
    // run-first wording, the pre-fold docs-only check against <base> or the "commit and push after each step" rule survives.
    // Regression: the writer folds without the clean-tree check, rebases with autostash, pushes the side branch or forces.
    test("a side-lane Spec Writer's prompt carries the fold protocol and none of the run-first wording", async () => {
      const state = await setup();
      const { writer } = await withWriter(state);
      const prompt = state.spawned.at(-1).prompt as string;
      expect(section(prompt, "Wave")).toContain("Wave 1 of 2: you run in parallel with its worker, in your own worktree on a side branch cut from feature/chain.");
      expect(section(prompt, "Fold")).toBe([
        `Commit only docs/ on your worktree branch. Before you report ready, fold the commits onto ${CHAIN}:`,
        "1. Require a clean tree: `git status --porcelain` prints nothing.",
        `2. \`git fetch origin ${CHAIN}\`, then note \`U=$(git rev-parse origin/${CHAIN})\`.`,
        `3. \`git rebase --no-autostash origin/${CHAIN}\`. On a conflict, run \`git rebase --abort\` and report blocked, recommending \`chief_delegate (replaces: <your thread id>, kind: spec-writer)\`.`,
        "4. `git diff --name-only $U..HEAD` lists only docs/ paths. Any other path: report blocked.",
        `5. \`git push origin HEAD:${CHAIN}\`. Never pass --force. If the push is rejected, repeat from step 1.`,
        "Record `Fold base: <U of the successful attempt>` and `Fold head: <the pushed sha>` in your report. When no docs change was needed, record `Fold: none` with Fold base and Fold head both equal to U.",
        "Never use autostash, never force, never touch another worktree.",
      ].join("\n") + "\n");
      expect(section(prompt, "Git workflow")).toContain("The only push you make is the fold into feature/chain");
      expect(prompt).toContain("Push only through the `## Fold` steps");
      expect(prompt).toContain("A delta item the docs already reflect needs no commit: say so, and record `Fold: none`.");
      expect(prompt).not.toMatch(/you run before its worker|git diff --name-only <base>\.\.HEAD|Commit and push after each meaningful step|Commit and push your work/);
      expect(rowOf(state, writer).kind).toBe("spec-writer");
    });

    // Wave 2 contract 6 (planner brief): the planner is told the Spec Writer commits docs in parallel with the wave's worker, which builds from
    // the plan, and is never told the writer runs first. Regression: the planner brief again describes a writer-first chain.
    test("the planner's brief says the Spec Writer commits in parallel and the worker builds from the plan", async () => {
      const state = await setup();
      const chief = await start(state);
      await plan(state, chief.threadId, [specImpl(), TEST_WAVE(2)]);
      const prompt = state.spawned.find((entry: any) => entry.prompt.startsWith("You are the managed planner"))!.prompt as string;
      expect(prompt).toContain("give that wave a `## Spec delta` heading for the Spec Writer, who commits the docs in parallel with the wave's worker (the worker builds from the plan, so write the plan wave in full).");
      expect(prompt).not.toMatch(/runs its Spec Writer before its worker|Spec Writer runs first|before its worker/);
    });

    // Wave 2 contract 3 (tester): the tester checks each listed side writer's Fold head is an ancestor of its HEAD before deriving tests.
    // Regression: the tester derives tests from a checkout that lacks a writer's folded docs.
    test("a tester's prompt checks each listed side writer's Fold head is in its HEAD", async () => {
      const state = await setup();
      const { writer } = await fullChain(state);
      const prompt = state.spawned.at(-1).prompt as string;
      expect(section(prompt, "Spec")).toContain(`Wave 1 Spec Writer ${writer}:`);
      expect(section(prompt, "Spec")).toContain("- Before you derive tests, for each Spec Writer listed above run `git merge-base --is-ancestor <Fold head> HEAD`, using the Fold head from that writer's report. If it fails, report blocked: that writer's docs are not in your HEAD. A report with no Fold head (an implementation-lane writer) needs no check.");
      expect(section(prompt, "Git workflow")).toContain(localSync(CHAIN));
    });

    // Wave 2 contract 2/4 (fix worker): a test-wave product-fix worker keeps the docs-matching block with the chain's writer report
    // (the folded docs are its spec), plus the local sync. Regression: the fix worker never sees the docs it must match.
    test("a test-wave product-fix worker gets the Spec block with the chain's writer report and the local sync", async () => {
      const state = await setup();
      const { chief, planner, writer, tester } = await fullChain(state);
      await swap(state, chief, planner.threadId, 2, tester, "worker");
      const prompt = state.spawned.at(-1).prompt as string;
      expect(section(prompt, "Spec")).toBe([WORKER_SPEC_RULES[0], `Wave 1 Spec Writer ${writer}: report ${rowOf(state, writer).report_path ?? "none"}`, ...WORKER_SPEC_RULES.slice(1)].join("\n") + "\n");
      expect(section(prompt, "Git workflow")).toContain(localSync(CHAIN));
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

    // Retest debt contract (docs/specs/plan-chains.md "Retest Debt", live owner): the rerun route replaces the chain's live owner, and
    // following it through the real chief_delegate is admitted in the owner's environment. Regression: a route naming the fix instead of
    // the writer owner is refused by the holder rule; one that is not executable strands the debt.
    test("a test-wave Spec Writer repair owns the branch: the retest route replaces it and is admitted in its environment", async () => {
      const state = await setup();
      const { chief, planner, tester } = await fullChain(state);
      await reviewed(state, chief.threadId, tester, "request_changes");
      await tick();
      const fix = await swap(state, chief, planner.threadId, 2, tester, "worker");
      await readyIdle(state, fix);
      await tick();
      const writer = await swap(state, chief, planner.threadId, 2, fix, "spec-writer");
      await readyIdle(state, writer);
      const message = await refusal(review(state, chief, writer));
      expect(message).toContain(`rerun the tests — ${rerunRoute(planner, 2, writer)}.`);
      const followed = await followRoute(state, chief.threadId, message);
      expect(rowOf(state, followed.thread)).toMatchObject({ kind: "tester", replaces_thread_id: writer, plan_wave: 2 });
      expect(state.live.get(followed.thread)!.environmentId).toBe(state.live.get(writer)!.environmentId);
      expect(state.spawned.at(-1).environment).toEqual({ type: "reuse", environmentId: state.live.get(writer)!.environmentId });
    });

    test("an unplanned Spec Writer owner routes the rerun through a worker first, and that call is admitted", async () => {
      const state = await setup();
      const chief = await start(state);
      const first = await delegate(state, chief.threadId, "Fix totals");
      await readyIdle(state, first.threadId, "Done");
      await reviewed(state, chief.threadId, first.threadId, "request_changes");
      await tick();
      const fix = (await delegate(state, chief.threadId, "Fix", { replaces: first.threadId })).threadId;
      await readyIdle(state, fix, "Fixed");
      await tick();
      await tool(state, "chief_delegate", { title: "Docs", mission: "Update docs", replaces: fix, kind: "spec-writer", unplannedReason: "Bounded" }, chief.threadId);
      const writer = (await status(state)).threads.filter((row) => row.role === "worker").at(-1)!.threadId;
      await readyIdle(state, writer, "Docs done");
      const message = await refusal(review(state, chief, writer));
      expect(message).toContain(`Spec Writer ${writer} owns the branch: hand off to a worker first — chief_delegate (replaces: ${writer}, kind: worker) — then rerun the tests with kind: tester.`);
      const followed = await followRoute(state, chief.threadId, message, 0, "Hand off");
      expect(rowOf(state, followed.thread)).toMatchObject({ kind: null, role: "worker", replaces_thread_id: writer });
    });

    // Retest debt contract (exemptions): only a worker row created after a rejection is a fix. A Spec Writer's docs repair (side-lane or
    // implementation-lane) is no code change and owes no rerun by itself. Regression: any row after a rejection counts as a fix, so a
    // docs-only repair is refused with a tester-rerun route it cannot satisfy.
    test.each([["a side-lane docs repair", "side"], ["an implementation-lane docs repair", "implementation"]] as const)("%s after a rejection owes no tester rerun", async (_label, lane) => {
      const state = await setup();
      const { chief, planner, writer, tester } = await fullChain(state);
      await reviewed(state, chief.threadId, tester, "request_changes");
      await tick();
      const repair = await swap(state, chief, planner.threadId, lane === "side" ? 1 : 2, lane === "side" ? writer : tester, "spec-writer");
      await readyIdle(state, repair);
      await tick();
      const before = await reviewerCount(state);
      // The side writer never starts a review itself (its chain tip does): the debt question is the tip's, so review the tip.
      expect(await review(state, chief, lane === "side" ? tester : repair)).toMatch(/^Started “Review · Wave 2”/);
      expect(await reviewerCount(state)).toBe(before + 1);
    });

    // Retest debt contract (refusal order, case 10): a side writer that is not ready is refused as writers before any retest, and the refusal
    // carries no waiver. Regression: the retest check runs first, so Chief reruns tests on a chain whose docs are still being written.
    test("a busy side-lane writer is refused as writers before the owed retest, with no waiver offered", async () => {
      const state = await setup();
      const { chief, planner, writer, tester } = await fullChain(state);
      await reviewed(state, chief.threadId, tester, "request_changes");
      await tick();
      const fix = await swap(state, chief, planner.threadId, 2, tester, "worker");
      await readyIdle(state, fix);
      await tick();
      // Control: with the writer ready the same review is the retest refusal.
      expect(await refusal(review(state, chief, fix))).toContain(`${fix} changed code after the review's rejection`);
      const repair = await swap(state, chief, planner.threadId, 1, writer, "spec-writer");
      const message = await refusal(review(state, chief, fix));
      expect(message).toBe(`One review covers the whole plan once every Spec Writer is ready; wave 1's ${repair} (starting) is not ready. Wait for their ready reports, then start the review.`);
      expect(message).not.toContain("changed code after");
      expect(message).not.toContain("retestSkipped");
      expect(rowOf(state, repair).state).not.toBe("ready");
      expect(await reviewerCount(state)).toBe(1);
    });
  });
});
