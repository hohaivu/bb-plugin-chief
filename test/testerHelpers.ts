import { HEAD_SHA, PLAN_FIXTURE, execFileMock, ghHead, setup, start, status, wave } from "./harness";

export type State = Awaited<ReturnType<typeof setup>>;
export const ctxOf = (state: State, chiefThreadId: string) => ({ threadId: chiefThreadId, projectId: state.live.get(chiefThreadId)!.projectId });
export const tool = (state: State, name: string, params: object, chiefThreadId: string) =>
  state.harness.behavior.callAgentTool(name, params, ctxOf(state, chiefThreadId)) as Promise<any>;
export const report = (state: State, threadId: string, params: object) =>
  state.harness.behavior.callAgentTool("chief_report", params, { threadId, projectId: "proj_1" }) as Promise<any>;
export const rowOf = (state: State, threadId: string) => state.db.prepare(`SELECT * FROM managed_threads WHERE thread_id=?`).get(threadId) as any;
export const setLive = (state: State, threadId: string, status: string) => state.live.set(threadId, { ...state.live.get(threadId)!, status } as any);

/** A planner whose ready report carries `waves` (default: one implementation wave). Two implementation waves need an advisor review before delegation: approvePlan. */
export async function plan(state: State, chiefThreadId: string, waves: object[] = [{ body: PLAN_FIXTURE }]) {
  await state.harness.behavior.runCli(["plan", "--title", "Rework checkout", "--mission", "Propose how to fix totals", "--undesigned-reason", "small fix"], ctxOf(state, chiefThreadId));
  const planner = (await status(state)).threads.filter((row) => row.role === "planner" && row.chiefThreadId === chiefThreadId).at(-1)!;
  await report(state, planner.threadId, { state: "ready", result: "Waves written.", plan: waves });
  return planner;
}

export const delegateWave = (state: State, chiefThreadId: string, planThreadId: string, waveNo: number, extra: object = {}) =>
  tool(state, "chief_delegate", { title: `Wave ${waveNo}`, mission: "Do the wave.", planThreadId, wave: waveNo, ...extra }, chiefThreadId);

// A plan worker's ready report must carry a Deviations heading.
export const READY = "Done.\n\n## Deviations from plan\nNone";
/** The newest worker row on a plan wave. */
export const workerOn = (state: State, planThreadId: string, waveNo: number) =>
  state.db.prepare(`SELECT * FROM managed_threads WHERE plan_thread_id=? AND plan_wave=? AND role='worker' ORDER BY rowid DESC`).get(planThreadId, waveNo) as any;
export const planWaves = (state: State, planThreadId: string) =>
  (state.db.prepare(`SELECT plan_waves FROM managed_threads WHERE thread_id=?`).get(planThreadId) as { plan_waves: string }).plan_waves;

/** An implementation wave: wave 1 is the plan fixture, every other wave a plain wave body. */
export const planWave = (n: number, extra: object = {}) => ({ body: n === 1 ? PLAN_FIXTURE : wave(n), ...extra });
/** Chief reviews `targetId`; its reviewer reports `verdict`. Returns the alert Chief received. */
export async function reviewed(state: State, chiefThreadId: string, targetId: string, verdict: "approve" | "request_changes", extra: object = {}) {
  await tool(state, "chief_review", { workerThreadId: targetId, ...extra }, chiefThreadId);
  const reviewer = (await status(state)).threads.filter((row) => row.role === "reviewer" && row.workerThreadId === targetId && row.state !== "complete").at(-1)!;
  await report(state, reviewer.threadId, {
    state: "ready", result: "The discount is still applied twice", verdict,
    findings: verdict === "approve" ? [] : [{ file: "totals.ts", line: 3, severity: "blocking", message: "The discount is applied twice", fix: "Apply it once" }],
  });
  return state.sent.at(-1).input[0].text as string;
}
export const readyIdle = async (state: State, threadId: string, result = READY) => { await report(state, threadId, { state: "ready", result }); setLive(state, threadId, "idle"); };

/** The plan file path of every wave of a planner. */
export const wavePaths = (state: State, planThreadId: string) => (JSON.parse(planWaves(state, planThreadId)) as { path: string }[]).map((entry) => entry.path);


/** A real ms boundary: verdict and row times are Date.now(), and a fix only counts when created strictly after the rejection. */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 3));

/** Executes the `index`th chief_delegate call a refusal or alert text advertises (the route sweep): the text is the only source of its parameters. */
export async function followRoute(state: State, chiefThreadId: string, text: string, index = 0, mission = "Rerun the tests.") {
  const call = [...text.matchAll(/chief_delegate \(([^)]*)\)/g)][index];
  if (!call) throw new Error(`no chief_delegate route #${index} in: ${text}`);
  const params = Object.fromEntries(call[1]!.split(", ").map((pair) => { const [key, value] = pair.split(": "); return [key, key === "wave" ? Number(value) : value]; }));
  const before = new Set((await status(state)).threads.map((row) => row.threadId));
  await tool(state, "chief_delegate", { title: "Route", mission, ...params }, chiefThreadId);
  const created = (await status(state)).threads.filter((row) => !before.has(row.threadId));
  return { params, thread: created.at(-1)!.threadId as string };
}
export const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as Error).message; } throw new Error("expected a refusal"); };

/** Chief + a one-wave plan with wave 1 delegated, ready and idle. */
export async function readyImpl(state: State, wave1: object = {}) {
  const chief = await start(state);
  const planner = await plan(state, chief.threadId);
  await delegateWave(state, chief.threadId, planner.threadId, 1, wave1);
  const impl = workerOn(state, planner.threadId, 1);
  await report(state, impl.thread_id, { state: "ready", result: READY });
  setLive(state, impl.thread_id, "idle");
  return { chief, planner, impl: impl.thread_id as string };
}

export const review = (state: State, chief: { threadId: string }, workerThreadId: string, extra: object = {}) => tool(state, "chief_review", { workerThreadId, ...extra }, chief.threadId);
export const reviewerCount = async (state: State) => (await status(state)).threads.filter((row) => row.role === "reviewer").length;

// The review gate pins each target's head through the forge (`gh pr view`), so a gate target carries a branch and a pull request.
export const PR_URL = "https://github.com/o/r/pull/7";
/** The forge answers `gh pr view <url>` with that pull request's pinned head (HEAD_SHA, base main); any other command answers empty. */
export const forgeAnswers = (prs: Record<string, string> = { [PR_URL]: "feature/x" }, state?: "OPEN") =>
  execFileMock.mockImplementation((file: string, args: string[]) => {
    // The forge reads a pull request URL as its number plus --repo, so the number picks the pull request.
    const url = file === "gh" && args[0] === "pr" && args[1] === "view" ? Object.keys(prs).find((key) => key.endsWith(`/pull/${args[2]}`)) : undefined;
    const branch = url ? prs[url] : undefined;
    return Promise.resolve({ stdout: branch ? (state && args.includes("state,headRefOid") ? JSON.stringify({ state, headRefOid: HEAD_SHA }) : ghHead(branch)) : "", stderr: "" });
  });
export type Gate = { gate_key: string; reviewer_thread_id: string; tester_thread_id: string; fixer_thread_id: string | null; corrector_thread_id: string | null; targets: string };
/** The review gate that pinned `threadId`. */
export const gateOf = (state: State, threadId: string) =>
  (state.db.prepare(`SELECT * FROM review_gates`).all() as Gate[]).find((gate) => (JSON.parse(gate.targets) as { threadId: string }[]).some((target) => target.threadId === threadId));
/** Opens the review gate on `targetId` (chief_review) and returns it: one reviewer and one tester started. */
export async function openGate(state: State, chiefThreadId: string, targetId: string) {
  await tool(state, "chief_review", { workerThreadId: targetId }, chiefThreadId);
  return gateOf(state, targetId)!;
}
/** The spawn record (prompt, environment) of thread `threadId`: thr_<n> is the n-th spawn. */
export const spawnOf = (state: State, threadId: string) => state.spawned[Number(threadId.slice("thr_".length)) - 1];
/** The gate tester reports ready (idle) with its test result. */
export async function testerReady(state: State, gate: Gate, passed: boolean, result = passed ? "Every test passes." : "Tests fail.\n\n## Failing tests\n- totals.test.ts:3 — `npx vitest run totals.test.ts`, exit 1: totals go negative (totals.ts:4)") {
  await report(state, gate.tester_thread_id, { state: "ready", result, testsPassed: passed });
  setLive(state, gate.tester_thread_id, "idle");
}
/** The gate reviewer reports its verdict (idle). */
export async function reviewerVerdict(state: State, gate: Gate, verdict: "approve" | "request_changes", findings: object[] = verdict === "approve" ? [] : [...REQUEST_CHANGES_FINDINGS]) {
  await report(state, gate.reviewer_thread_id, { state: "ready", result: verdict === "approve" ? "The change holds." : "Totals go negative.", verdict, findings });
  setLive(state, gate.reviewer_thread_id, "idle");
}
export const REQUEST_CHANGES_FINDINGS = [{ file: "totals.ts", line: 4, severity: "blocking", message: "Totals go negative.", fix: "Clamp at zero" }] as const;
/** Opens the gate on `targetId` and passes it: green tester, approving reviewer. Chief can then chief_complete the target. */
export async function passGate(state: State, chiefThreadId: string, targetId: string) {
  const gate = await openGate(state, chiefThreadId, targetId);
  await testerReady(state, gate, true);
  await reviewerVerdict(state, gate, "approve");
  return gate;
}
