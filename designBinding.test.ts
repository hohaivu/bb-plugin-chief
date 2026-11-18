import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { PLAN_FIXTURE, delegate, disposeAll, execFileMock, setup, start, status } from "./test/harness";
import { planWave, report, rowOf, tool } from "./test/testerHelpers";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// The approved design binding (docs/specs/plan-chains.md "Approved Design Binding"; plan thr_zbmxhv55e9 wave 2).
describe("approved design binding", () => {
  type State = Awaited<ReturnType<typeof setup>>;
  const DESIGN = "# Design\n\n## Resolved decisions\n- Sessions live in SQLite. DESIGN-ORIGINAL\n";
  const EDITED = "# Design\n\n## Resolved decisions\n- Sessions live in Redis. DESIGN-EDITED\n";
  const FACTS = `Helpers: 2\nDesign: DESIGN_PATH\n## Facts\n${"- fact with evidence a.ts:1\n".repeat(60)}FACTS-TAIL\n## Unconfirmed\nNone`;
  const plannerSpawns = (state: State) => state.spawned.filter((args) => args.pluginMetadata?.role === "planner");
  const plannerRows = (state: State) => state.db.prepare("SELECT thread_id, research_thread_id, replaces_thread_id FROM managed_threads WHERE role='planner' ORDER BY rowid").all() as { thread_id: string; research_thread_id: string | null; replaces_thread_id: string | null }[];
  const designFile = (state: State, researcher: string) => join(state.storageRoot, researcher, "design.md");
  const artifact = (state: State, researcher: string, name: string) => join(state.storageRoot, "chief", "proj_1", researcher, name);
  const snapshotsOf = (state: State, researcher: string) => ({ design: artifact(state, researcher, "design-approved-r1.md"), facts: artifact(state, researcher, "facts-approved-r1.md") });

  /** A Chief with a design researcher that reported ready after the user approved `design.md`. */
  async function approved(options: Parameters<typeof setup>[0] = {}, design = DESIGN) {
    const state = await setup({ heavyFiles: true, ...options });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    const opts = { threadId: chief.threadId, projectId: "proj_1" };
    await state.harness.behavior.callAgentTool("chief_research", { question: "Add sessions", design: true }, opts);
    const researcher = (await status(state)).threads.find((row: { role: string }) => row.role === "researcher")!.threadId;
    await mkdir(join(state.storageRoot, researcher), { recursive: true });
    await writeFile(designFile(state, researcher), design);
    await report(state, researcher, { state: "ready", result: FACTS.replace("DESIGN_PATH", designFile(state, researcher)) });
    return { state, chief: chief.threadId, opts, researcher };
  }
  const planWith = (state: State, chief: string, researchThreadId: string, extra: object = {}) =>
    tool(state, "chief_plan", { title: "Sessions", mission: "Plan the sessions work", researchThreadId, ...extra }, chief) as Promise<string>;
  const lastPlannerPrompt = (state: State) => plannerSpawns(state).at(-1)!.prompt as string;

  // Contract (plan-chains.md Snapshots): the first bind writes design-approved-r<seq>.md (design.md's text) and facts-approved-r<seq>.md (the researcher row's full result);
  // the planner brief names both paths and never holds their text. Regression: planner briefed with title and mission only, or with the design inlined.
  test("the first chief_plan writes both snapshots and briefs the planner with their paths, not their text", async () => {
    const { state, chief, researcher } = await approved();
    await planWith(state, chief, researcher);
    const snap = snapshotsOf(state, researcher);
    expect(await readFile(snap.design, "utf8")).toBe(DESIGN);
    expect(await readFile(snap.facts, "utf8")).toBe(rowOf(state, researcher).result);
    const prompt = lastPlannerPrompt(state);
    expect(prompt).toContain(snap.design);
    expect(prompt).toContain(snap.facts);
    expect(prompt.indexOf("## Approved design")).toBeGreaterThan(-1);
    expect(prompt.indexOf("## Approved design")).toBeLessThan(prompt.indexOf("## Problem"));
    expect(prompt).not.toContain("DESIGN-ORIGINAL");
    expect(prompt).not.toContain("FACTS-TAIL");
    expect(plannerRows(state).at(-1)!.research_thread_id).toBe(researcher);
  });

  // Contract (plan-chains.md Snapshots; plan 2): the facts snapshot is the row's full `result`, not the report file, which is best-effort.
  // Regression: facts read from report_path, so a failed report-file write loses the facts.
  test("the facts snapshot holds the full result when the researcher has no report file", async () => {
    const state = await setup({ heavyFiles: true });
    await state.harness.behavior.setSettings({ plannerEnabled: true });
    const chief = await start(state);
    await state.harness.behavior.callAgentTool("chief_research", { question: "Add sessions", design: true }, { threadId: chief.threadId, projectId: "proj_1" });
    const researcher = (await status(state)).threads.find((row: { role: string }) => row.role === "researcher")!.threadId;
    await mkdir(join(state.storageRoot, researcher), { recursive: true });
    await writeFile(designFile(state, researcher), DESIGN);
    state.failWritesMatching(/report-\d+\.md/);
    await report(state, researcher, { state: "ready", result: FACTS });
    state.failWritesMatching(null);
    const row = rowOf(state, researcher);
    expect(row.report_path).toBeNull();
    expect(row.result.length).toBeGreaterThan(800);
    await planWith(state, chief.threadId, researcher);
    expect(await readFile(snapshotsOf(state, researcher).facts, "utf8")).toBe(row.result);
  });

  // Contract (plan-chains.md Snapshots, Invariants): a snapshot never changes after its first write; a later bind, a revision and the pull request body read the same text.
  // Regression: a second plan, or a revision, re-snapshotting the edited design.md.
  test("after design.md changes, a second plan and a revises planner reference the same unchanged snapshots", async () => {
    const { state, chief, researcher } = await approved();
    await planWith(state, chief, researcher);
    const snap = snapshotsOf(state, researcher);
    await writeFile(designFile(state, researcher), EDITED);
    await planWith(state, chief, researcher);
    expect(await readFile(snap.design, "utf8")).toBe(DESIGN);
    const second = lastPlannerPrompt(state);
    expect(second).toContain(snap.design);
    expect(second).toContain(snap.facts);

    const original = plannerRows(state).at(-1)!.thread_id;
    await report(state, original, { state: "ready", result: "Waves written.", plan: [planWave(1), planWave(2)] });
    await tool(state, "chief_consult", { planThreadId: original, title: "Plan", mission: "Review this plan" }, chief);
    const advisor = (await status(state)).threads.filter((row: { role: string }) => row.role === "advisor").at(-1)!;
    await report(state, advisor.threadId, { state: "ready", result: "Split the waves differently.", verdict: "request_changes" });
    await tool(state, "chief_plan", { title: "Revise", mission: "Propose again", revises: original }, chief);
    expect(plannerRows(state).at(-1)).toMatchObject({ replaces_thread_id: original, research_thread_id: researcher });
    const revision = lastPlannerPrompt(state);
    expect(revision).toContain(snap.design);
    expect(revision).toContain(snap.facts);
    expect(revision).not.toContain("DESIGN-EDITED");
    expect(await readFile(snap.design, "utf8")).toBe(DESIGN);
  });

  // Contract (plan-chains.md Snapshots and Invariants; the wave-2 hazard): a snapshot is write-once, so a failed read of an existing snapshot never lets the bind rewrite it
  // from the current design.md. Regression: readArtifact failing (a transient host error) is treated as "no snapshot yet", and the edited design replaces the approved one.
  test("a failed read of an existing design snapshot never overwrites it", async () => {
    let failSnapshotReads = false;
    const { state, chief, researcher } = await approved({ onFileRead: (path) => { if (failSnapshotReads && path.includes("-approved-")) throw new Error("HTTP 503: host unavailable"); } });
    await planWith(state, chief, researcher);
    const snap = snapshotsOf(state, researcher);
    await writeFile(designFile(state, researcher), EDITED);
    failSnapshotReads = true;
    await planWith(state, chief, researcher).catch(() => undefined);
    failSnapshotReads = false;
    expect(await readFile(snap.design, "utf8")).toBe(DESIGN);
    expect(await readFile(snap.facts, "utf8")).toBe(rowOf(state, researcher).result);
  });

  // Contract (plan-chains.md Approved Design Binding): an unreadable snapshot refuses the plan before any planner starts; it is never replaced from the edited design.md.
  // Regression: the refusal swallowed (plan starts on no design) or the bind falling back to the live design.md.
  test("an unreadable design snapshot refuses a later plan before any planner starts", async () => {
    let failSnapshotReads = false;
    const { state, chief, researcher } = await approved({ onFileRead: (path) => { if (failSnapshotReads && path.includes("-approved-")) throw new Error("HTTP 503: host unavailable"); } });
    await planWith(state, chief, researcher);
    const snap = snapshotsOf(state, researcher);
    await writeFile(designFile(state, researcher), EDITED);
    failSnapshotReads = true;
    const spawned = plannerSpawns(state).length;
    await expect(planWith(state, chief, researcher)).rejects.toThrow(/Could not read design-approved-r1\.md.*nothing was started/);
    failSnapshotReads = false;
    expect(plannerSpawns(state)).toHaveLength(spawned);
    expect(plannerRows(state)).toHaveLength(spawned);
    expect(await readFile(snap.design, "utf8")).toBe(DESIGN);
  });

  // Contract (plan-chains.md Approved Design Binding): a revision reads only its bound snapshot pair; a missing snapshot refuses before any spawn and is never recreated from design.md.
  // Regression: a revision that re-snapshots the live design.md or starts without the design.
  test("a revision whose bound snapshot is missing refuses before any planner starts and recreates nothing", async () => {
    const { state, chief, researcher } = await approved();
    await planWith(state, chief, researcher);
    const snap = snapshotsOf(state, researcher);
    const original = plannerRows(state).at(-1)!.thread_id;
    await report(state, original, { state: "ready", result: "Waves written.", plan: [planWave(1), planWave(2)] });
    await tool(state, "chief_consult", { planThreadId: original, title: "Plan", mission: "Review this plan" }, chief);
    const advisor = (await status(state)).threads.filter((row: { role: string }) => row.role === "advisor").at(-1)!;
    await report(state, advisor.threadId, { state: "ready", result: "Split the waves differently.", verdict: "request_changes" });
    await rm(snap.design);
    const spawned = plannerSpawns(state).length;
    await expect(tool(state, "chief_plan", { title: "Revise", mission: "Propose again", revises: original }, chief)).rejects.toThrow(/design-approved-r1\.md.*is missing; nothing was started/);
    expect(plannerSpawns(state)).toHaveLength(spawned);
    await expect(readFile(snap.design, "utf8")).rejects.toThrow();
  });

  describe("chief_plan refusals", () => {
    const refusals: [string, (ctx: Awaited<ReturnType<typeof approved>>) => Promise<object> | object, RegExp][] = [
      ["an unknown researcher", () => ({ researchThreadId: "thr_missing" }), /No managed researcher/],
      ["a thread that is not a researcher", async ({ state, chief }) => ({ researchThreadId: (await delegate(state, chief)).threadId }), /No managed researcher/],
      ["a researcher another Chief owns", ({ state, researcher }) => { state.db.prepare("UPDATE managed_threads SET chief_thread_id='thr_other' WHERE thread_id=?").run(researcher); return { researchThreadId: researcher }; }, /No managed researcher/],
      ["a researcher whose last report is not ready", ({ state, researcher }) => { state.db.prepare("UPDATE managed_threads SET state='active', last_report_state='active' WHERE thread_id=?").run(researcher); return { researchThreadId: researcher }; }, /no approved design yet/],
      ["a design.md that is empty", async ({ state, researcher }) => { await writeFile(designFile(state, researcher), "  \n"); return { researchThreadId: researcher }; }, /missing or empty/],
      ["a design.md that is missing", async ({ state, researcher }) => { await writeFile(designFile(state, researcher), ""); return { researchThreadId: researcher }; }, /missing or empty/],
      ["a design.md over 40,000 characters", async ({ state, researcher }) => { await writeFile(designFile(state, researcher), "x".repeat(40_001)); return { researchThreadId: researcher }; }, /over the 40,000 limit/],
      ["researchThreadId and undesignedReason together", ({ researcher }) => ({ researchThreadId: researcher, undesignedReason: "small fix" }), /not both/],
      ["neither input while research is on", () => ({}), /researchThreadId|undesignedReason/],
    ];
    // Contract (plan-chains.md Approved Design Binding): every refusal happens before any spawn, freshen or row insert. Regression: a refusal that leaves a planner row or thread behind.
    test.each(refusals)("%s is refused before any thread starts", async (_name, arrange, message) => {
      const ctx = await approved();
      const extra = await arrange(ctx);
      await delegate(ctx.state, ctx.chief); // the thread store reloads its row cache on this write, so the raw UPDATEs above take effect
      const spawned = ctx.state.spawned.length;
      const rows = ctx.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get() as { n: number };
      execFileMock.mockClear();
      await expect(tool(ctx.state, "chief_plan", { title: "Sessions", mission: "Plan it", ...extra }, ctx.chief)).rejects.toThrow(message);
      expect(ctx.state.spawned).toHaveLength(spawned);
      expect(ctx.state.db.prepare("SELECT COUNT(*) AS n FROM managed_threads").get()).toEqual(rows);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    test("a light researcher is refused", async () => {
      const state = await setup({ heavyFiles: true });
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      await state.harness.behavior.callAgentTool("chief_research", { question: "Who calls this?", design: false }, { threadId: chief.threadId, projectId: "proj_1" });
      const researcher = (await status(state)).threads.find((row: { role: string }) => row.role === "researcher")!.threadId;
      await report(state, researcher, { state: "ready", result: "Helpers: 0\nAnswer." });
      await expect(planWith(state, chief.threadId, researcher)).rejects.toThrow(/ran without design/);
      expect(plannerSpawns(state)).toHaveLength(0);
    });

    // Contract (plan-chains.md): with research off chief_plan accepts a plan with neither input, and still takes either one. Regression: the gate applied while the design flow is off.
    test("with research off a plan needs neither input", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      await state.harness.behavior.callRpc("setResearchSettings", { enabled: false });
      await tool(state, "chief_plan", { title: "Sessions", mission: "Plan it" }, chief.threadId);
      expect(plannerRows(state)).toHaveLength(1);
      expect(plannerRows(state)[0]!.research_thread_id).toBeNull();
      expect(lastPlannerPrompt(state)).not.toContain("## Approved design");
    });

    // Contract (plan-chains.md): undesignedReason records the skip as one Context line. Regression: the reason dropped, or a design section added for an undesigned plan.
    test("an undesigned plan records the reason in the brief and has no design section", async () => {
      const state = await setup();
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      await tool(state, "chief_plan", { title: "Sessions", mission: "Plan it", undesignedReason: "small fix" }, chief.threadId);
      expect(lastPlannerPrompt(state)).toContain("Design discussion skipped: small fix");
      expect(lastPlannerPrompt(state)).not.toContain("## Approved design");
    });
  });

  describe("bb chief plan", () => {
    const cli = (state: State, chief: string, ...args: string[]) => state.harness.behavior.runCli(["plan", "--title", "Sessions", "--mission", "Plan it", ...args], { threadId: chief, projectId: "proj_1" });

    // Contract (plan-1/2 CLI parity): `bb chief plan` takes --research-thread and --undesigned-reason with the tool's rules. Regression: a flag the tool has and the CLI lacks.
    test("accepts --research-thread and --undesigned-reason as the tool does", async () => {
      const { state, chief, researcher } = await approved();
      const bound = await cli(state, chief, "--research-thread", researcher);
      expect(bound.exitCode).toBe(0);
      expect(plannerRows(state).at(-1)!.research_thread_id).toBe(researcher);
      expect(lastPlannerPrompt(state)).toContain(snapshotsOf(state, researcher).design);
      expect((await cli(state, chief, "--undesigned-reason", "small fix")).exitCode).toBe(0);
      expect(lastPlannerPrompt(state)).toContain("Design discussion skipped: small fix");
    });

    test.each([
      ["both inputs", (r: string) => ["--research-thread", r, "--undesigned-reason", "x"], /not both/],
      ["neither input", () => [], /researchThreadId or undesignedReason|researchThreadId/],
      ["--revises with an input", (r: string) => ["--revises", "thr_x", "--research-thread", r], /inherits/],
    ])("refuses %s before any thread starts", async (_name, args, message) => {
      const { state, chief, researcher } = await approved();
      const spawned = state.spawned.length;
      const result = await cli(state, chief, ...args(researcher));
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toMatch(message);
      expect(state.spawned).toHaveLength(spawned);
    });
  });

  describe("chief_forge_init", () => {
    async function approvePlan(state: State, chief: string, planner: string) {
      await tool(state, "chief_consult", { planThreadId: planner, title: "Plan", mission: "Review this plan" }, chief);
      const advisor = (await status(state)).threads.filter((row) => row.role === "advisor").at(-1)!;
      await report(state, advisor.threadId, { state: "ready", result: "Plan approved.", verdict: "approve" });
    }

    /** The plan's one chain head: forge_init on wave 1 returns the script text (no project path), whose BODY holds the pull request body. */
    async function forgeBody(ctx: Awaited<ReturnType<typeof approved>>, planner: string) {
      await report(ctx.state, planner, { state: "ready", result: "Waves written.", plan: [planWave(1), planWave(2)] });
      await approvePlan(ctx.state, ctx.chief, planner);
      return tool(ctx.state, "chief_forge_init", { title: "Wave 1 work", planThreadId: planner, wave: 1 }, ctx.chief) as Promise<string>;
    }

    // Contract (plan-chains.md Pull request body): one full design block from the snapshot, with its marker and the fact-report path, after the plan block.
    // Regression: the block reading the live design.md, clipped, repeated, or missing its marker.
    test("the body has one full design block, read from the snapshot, with the marker", async () => {
      const long = `${DESIGN}${"- A long resolved decision. ".repeat(900)}DESIGN-TAIL\n`;
      const ctx = await approved({}, long);
      await planWith(ctx.state, ctx.chief, ctx.researcher);
      const snap = snapshotsOf(ctx.state, ctx.researcher);
      await writeFile(designFile(ctx.state, ctx.researcher), EDITED);
      const script = await forgeBody(ctx, plannerRows(ctx.state).at(-1)!.thread_id);
      const marker = `<!-- chief-design ${ctx.researcher} r1 -->`;
      expect(script.split(marker)).toHaveLength(2);
      expect(script.split("DESIGN-TAIL")).toHaveLength(2);
      expect(script).toContain("DESIGN-ORIGINAL");
      expect(script).not.toContain("DESIGN-EDITED");
      expect(script).toContain(`Fact report: ${snap.facts}`);
      expect(script.indexOf("Plan — chain of waves")).toBeLessThan(script.indexOf(marker));
      expect(script).not.toContain("FACTS-TAIL");
    });

    // Contract (plan-chains.md Pull request body: "A plan without a design keeps the pull request body it had before this change"): the BODY and ISSUE_BODY of an undesigned plan's wave 1 are the bytes 16bbc52 produced
    // (the literal below was captured from 16bbc52 with the same wave headings and contracts). Regression: a design block, marker or blank line leaking into a design-less body.
    test("an undesigned plan's forge body is byte-identical to the body 16bbc52 produced", async () => {
      const state = await setup({ heavyFiles: true });
      await state.harness.behavior.setSettings({ plannerEnabled: true });
      const chief = await start(state);
      await state.harness.behavior.callAgentTool("chief_plan", { title: "Sessions", mission: "Plan it", undesignedReason: "small fix" }, { threadId: chief.threadId, projectId: "proj_1" });
      const planner = plannerRows(state).at(-1)!.thread_id;
      await report(state, planner, { state: "ready", result: "Waves written.", plan: [{ body: PLAN_FIXTURE }, { body: "# Wave 2\n\n## Contracts to verify\n- Wave 2 keeps its invariant" }] });
      await approvePlan(state, chief.threadId, planner);
      const script = await tool(state, "chief_forge_init", { title: "Wave 1 work", planThreadId: planner, wave: 1 }, chief.threadId) as string;
      const body = `Tracking work for Wave 1 work.\n\n<details><summary>Plan — chain of waves 1, 2 of 2 (planner ${planner})</summary>\n\nWaves written.\n</details>\n\n<details><summary>Wave 1 of 2 — Plan</summary>\n\n### Contracts to verify\n- Totals stay non-negative\n</details>\n\n<details><summary>Wave 2 of 2 — Wave 2</summary>\n\n### Contracts to verify\n- Wave 2 keeps its invariant\n</details>`;
      expect(script).toContain(`\nBODY='${body}'\n`);
      expect(script).toContain("\nDESIGN_MARKER=''\n");
      expect(script).not.toContain("chief-design");
    });

    // Contract (plan-chains.md Pull request body): a reused pull request whose script reports the design block missing refuses the call. Regression: the call hands Chief a pull request with no design.
    test("a reused pull request that still lacks the design block refuses the call", async () => {
      const ctx = await approved({ projectPath: "/repo/proj1" });
      await planWith(ctx.state, ctx.chief, ctx.researcher);
      execFileMock.mockResolvedValue({ stdout: "CHIEF_FORGE branch=feature/x base=main issue_url=https://i/1 pr_url=https://p/2 forge=gh design=missing\n", stderr: "" });
      await expect(forgeBody(ctx, plannerRows(ctx.state).at(-1)!.thread_id)).rejects.toThrow(/lacks the approved design block/);
    });

    test("a pull request whose script reports the design block present is handed to Chief", async () => {
      const ctx = await approved({ projectPath: "/repo/proj1" });
      await planWith(ctx.state, ctx.chief, ctx.researcher);
      execFileMock.mockResolvedValue({ stdout: "CHIEF_FORGE branch=feature/x base=main issue_url=https://i/1 pr_url=https://p/2 forge=gh design=ok\n", stderr: "" });
      expect(await forgeBody(ctx, plannerRows(ctx.state).at(-1)!.thread_id)).toContain("pr_url=https://p/2");
    });
  });
});
