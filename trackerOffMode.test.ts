import { ATTACH_DEFINITION, acceptEvidenceOnlyDelta, acceptRetestDelta, acceptSpecLaneWording } from "./test/specLaneWording";
import { acceptRosterOthersDelta } from "./test/toolConfigFixture";
import { acceptReviewerToolDelta } from "./test/reviewerToolDelta";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVE, NO_DEVIATIONS, PLAN_FIXTURE, TEST_WAVE, chiefReview, configurationContext, delegate, disposeAll, execFileMock, ghHead, setup, start, status, wave } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);
// Byte-equivalence with base 310043a (before the tracker existed). The golden file test/fixtures/tracker-310043a.json was recorded on that
// commit by running the scenario block below, extracted verbatim between its markers, with ORACLE_OUT_TRACKER set. Here the head
// output of the same fixture, in each mode that must behave as "off", must equal it. With ORACLE_OUT_TRACKER set, this describe
// writes {meta, outputs} to that path instead of comparing.
// ==== TRACKER-ORACLE-SCENARIO-BEGIN ====
const TRACKER_ORACLE_BB = process.env.BB_CLI ?? "bb";
const TRACKER_ORACLE_FIXTURE = [
  "chief start; chief plan --title 'Rework checkout' --mission 'Propose how to fix totals'",
  "planner chief_report ready with plan [PLAN_FIXTURE, TEST_WAVE(2)]",
  "chief delegate wave 1 (--plan-thread, --wave 1, --issue-url)",
  "wave 1 chief_report ready; chief_escalate 'Which total rule?'",
  "chief delegate wave 2 (--replaces wave 1); worker report; chief review; reviewer chief_report approve; chief_complete wave 2",
  "resolveAgentConfiguration: the chief tool list with its parameter schemas",
  "supervisor cycles, then everything the owner or the host saw: results, alerts, forge comments, exec'd commands",
];
type TrackerOracleMode = { settings: Record<string, unknown>; bbTasks: "none" | "unavailable" };
async function trackerOracleRun(mode: TrackerOracleMode) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  execFileMock.mockReset();
  execFileMock.mockImplementation(async (file: string, args: string[]) => {
    if (file === "gh") return args[0] === "pr" ? { stdout: ghHead("feature/x"), stderr: "" } : { stdout: args.includes("POST") || args.includes("--paginate") ? "" : "boss\n", stderr: "" };
    if (file === TRACKER_ORACLE_BB && args[0] === "tasks") throw new Error("bb tasks is unavailable");
    return { stdout: "", stderr: "" };
  });
  const state = await setup();
  await state.harness.behavior.setSettings({ plannerEnabled: true, ...mode.settings });
  const norm = (text: string) => text.replaceAll(state.storageRoot, "<root>");
  const results: unknown[] = [];
  const cli = async (chief: string, args: string[]) => {
    const result = await state.harness.behavior.runCli(args, { threadId: chief, projectId: "proj_1" });
    results.push({ args: args.map(norm), exitCode: result.exitCode, stdout: norm(String(result.stdout)), stderr: norm(String(result.stderr)) });
    return result;
  };
  const tool = async (threadId: string, name: string, params: object) => {
    const result = await state.harness.behavior.callAgentTool(name, params, { threadId, projectId: "proj_1" });
    results.push({ tool: name, threadId, result: norm(JSON.stringify(result)) });
    return result as any;
  };
  const chief = (await start(state)).threadId;
  await cli(chief, ["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals"]);
  const planner = (await status(state)).threads.find((row) => row.role === "planner")!.threadId;
  await tool(planner, "chief_report", { state: "ready", result: "Waves written.", plan: [{ body: PLAN_FIXTURE }, TEST_WAVE(2)] });
  const delegateWave = async (args: string[]) => JSON.parse((await cli(chief, ["delegate", "--title", "Wave", "--mission", "Do it", ...args, "--json"])).stdout!) as { threadId: string };
  const wave1 = (await delegateWave(["--plan-thread", planner, "--wave", "1", "--issue-url", "https://github.com/acme/shop/issues/7"])).threadId;
  const finish = async (worker: string) => {
    await tool(worker, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` });
    const review = await chiefReview(state, chief, { workerThreadId: worker });
    results.push({ review: norm(JSON.stringify(review)) });
    await tool(review.threadId, "chief_report", { state: "ready", result: "Checked", ...APPROVE });
  };
  await tool(wave1, "chief_report", { state: "ready", result: `Done${NO_DEVIATIONS}` });
  await tool(chief, "chief_escalate", { threadId: wave1, request: "Which total rule?" });
  const wave2 = (await delegateWave(["--replaces", wave1, "--plan-thread", planner, "--wave", "2"])).threadId;
  await finish(wave2);
  await tool(chief, "chief_complete", { threadId: wave2 });
  const config = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief));
  const tools = JSON.parse(JSON.stringify(config.tools)) as { name: string }[];
  for (let i = 0; i < 4; i += 1) { await state.supervisorCycle(); await sleep(25); }
  for (let i = 0; i < 300 && state.db.prepare("SELECT 1 FROM forge_comments WHERE posted_at IS NULL AND gave_up_at IS NULL").get(); i += 1) await sleep(5);
  return {
    results,
    tools,
    alerts: state.sent.map((message) => [message.threadId, norm(String(message.input?.[0]?.text))]),
    forge: (state.db.prepare("SELECT dedupe_key, project_id, thread_id, target, body, mention, attempts, posted_at IS NOT NULL AS posted, gave_up_at IS NOT NULL AS gave_up FROM forge_comments ORDER BY dedupe_key").all() as object[])
      .map((row) => JSON.parse(norm(JSON.stringify(row)))),
    exec: execFileMock.mock.calls.map(([file, args]: [string, string[]]) => [file, args.map(norm)] as [string, string[]]),
  };
}
// ==== TRACKER-ORACLE-SCENARIO-END ====

describe("tracker off-mode equivalence with base 310043a", () => {
  const fixtureHash = createHash("sha256").update(JSON.stringify(TRACKER_ORACLE_FIXTURE)).digest("hex");
  const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "test/fixtures/tracker-310043a.json");
  type Golden = { meta: { head: string; fixtureHash: string; cwd: string; runnerRoot: string; scenarios: number }; outputs: Awaited<ReturnType<typeof trackerOracleRun>> };
  const statusProbe: [string, string[]] = [TRACKER_ORACLE_BB, ["tasks", "status", "--json"]];

  // Capture: runs on the base checkout only, where the settings below are unknown and ignored.
  test.runIf(process.env.ORACLE_OUT_TRACKER)("records the base output of the fixture", async () => {
    const outputs = await trackerOracleRun({ settings: {}, bbTasks: "none" });
    const { promisify } = await import("node:util");
    const real = promisify((await vi.importActual<typeof import("node:child_process")>("node:child_process")).execFile);
    const head = (await real("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })).stdout.trim();
    const meta = { cwd: process.cwd(), runnerRoot: dirname(fileURLToPath(import.meta.url)), head, fixtureHash, scenarios: TRACKER_ORACLE_FIXTURE.length };
    await writeFile(process.env.ORACLE_OUT_TRACKER!, `${JSON.stringify({ meta, outputs }, null, 2)}\n`);
  });

  // Contract (spec, Off, unmapped, and unavailable): with tracker=none, with bb-tasks on an unmapped project, and with a mapped project
  // whose bb tasks is unavailable, every chief_* result, alert (text and order), forge comment and exec'd command is byte-identical to
  // base 310043a for the same fixture, through the real tool callers. Only the new optional `merge` field of chief_escalate is excluded
  // from the tool schemas; the one extra exec allowed is the `bb tasks status --json` probe, and only when the project is mapped.
  // Regression: a tracker hook that changes a result string, alert, forge comment or schema, or that runs a CLI while off or unmapped.
  test.skipIf(process.env.ORACLE_OUT_TRACKER)("tool results, alerts, forge comments, commands and tool schemas equal the base recording for tracker none, unmapped and unavailable", async () => {
    const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as Golden;
    expect(golden.meta.head).toBe("310043a9b808607fbc6537c8a7672777b9c24868");
    expect(golden.meta.fixtureHash).toBe(fixtureHash);
    const withoutMerge = (outputs: Golden["outputs"]) => {
      const escalate = outputs.tools.find((tool) => tool.name === "chief_escalate") as any;
      expect(JSON.stringify(escalate)).toContain("merge");
      // Authorized Coordinator deltas (COORD-2/5/6), each asserted exactly, then removed: chief_coordinate; chief_spawn's optional projectId;
      // chief_escalate's optional threadId and its one added description sentence; and (#213) chief_attach, asserted in full.
      const coordinate = outputs.tools.find((tool) => tool.name === "chief_coordinate");
      expect(coordinate).toBeDefined();
      const attach = outputs.tools.find((tool) => tool.name === "chief_attach");
      expect({ description: attach?.description, inputSchema: attach?.inputSchema }).toEqual(ATTACH_DEFINITION);
      const spawn = JSON.parse(JSON.stringify(outputs.tools.find((tool) => tool.name === "chief_spawn")));
      expect(spawn.inputSchema.properties.projectId.description).toBe("Coordinator only: the project the new Chief works in. Defaults to your own project.");
      expect(spawn.inputSchema.required).not.toContain("projectId");
      delete spawn.inputSchema.properties.projectId;
      const stripped = JSON.parse(JSON.stringify(escalate, (key, value) => (key === "merge" ? undefined : value)));
      const SENTENCE = " Omit threadId only when no managed thread concerns the request yet.";
      expect(stripped.inputSchema.required).not.toContain("threadId");
      stripped.inputSchema.required = ["threadId", ...stripped.inputSchema.required];
      expect(stripped.description.endsWith(SENTENCE)).toBe(true);
      stripped.description = stripped.description.slice(0, -SENTENCE.length);
      return { ...outputs, tools: outputs.tools.filter((tool) => tool !== coordinate && tool !== attach).map((tool) => (tool === escalate ? stripped : tool.name === "chief_spawn" ? spawn : tool)) };
    };
    // [name, mode, whether the supervisor's one cached availability probe is expected]: off never probes; unmapped may (the probe runs before
    // any unit is read); a mapped project with units must.
    const modes: [string, TrackerOracleMode, "never" | "may" | "must"][] = [
      ["tracker=none", { settings: { tracker: "none" }, bbTasks: "none" }, "never"],
      ["bb-tasks, project not mapped", { settings: { tracker: "bb-tasks", trackerProjects: "proj_other=ABC" }, bbTasks: "none" }, "may"],
      ["bb-tasks, mapped, bb tasks unavailable", { settings: { tracker: "bb-tasks", trackerProjects: "proj_1=ABC" }, bbTasks: "unavailable" }, "must"],
    ];
    for (const [name, mode, probe] of modes) {
      const actual = await trackerOracleRun(mode);
      const extra = actual.exec.filter(([file, args]) => file === statusProbe[0] && args[0] === "tasks");
      expect(extra.every((call) => JSON.stringify(call) === JSON.stringify(statusProbe)), `${name}: the only extra exec is bb tasks status --json`).toBe(true);
      expect(probe === "never" ? extra.length === 0 : probe === "must" ? extra.length > 0 : true, `${name}: probe count ${extra.length}`).toBe(true);
      const rest = { ...actual, exec: actual.exec.filter((call) => !extra.includes(call)) };
      const baseSchemas = golden.outputs.tools;
      expect({ ...withoutMerge(rest), tools: undefined }, name).toEqual({ ...golden.outputs, tools: undefined });
      // Plan 2 contract 6: the Spec Writer wording of three tools moved; asserted, then restored to the recorded text.
      const shown = structuredClone(withoutMerge(rest).tools);
      for (const tool of shown) acceptSpecLaneWording(tool, baseSchemas.find((entry: any) => entry.name === tool.name), tool.name);
      for (const tool of shown) acceptReviewerToolDelta(tool, baseSchemas.find((entry: any) => entry.name === tool.name), tool.name);
      for (const tool of shown) acceptRetestDelta(tool, baseSchemas.find((entry: any) => entry.name === tool.name), tool.name);
      // #214: chief_delegate gains the optional evidenceOnly boolean; asserted, then removed.
      for (const tool of shown) acceptEvidenceOnlyDelta(tool, tool.name);
      // "Chief keeps tool search": chief_roster gains includeOthers and one description clause; asserted, then restored.
      for (const tool of shown) acceptRosterOthersDelta(tool, tool.name);
      expect(shown, `${name}: tool schemas`).toEqual(baseSchemas);
    }
  });
});
