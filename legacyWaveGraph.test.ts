import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createPlanProgress } from "./planProgress";
import { chainOf, createWaveSchedule, heads, successorOf, tips, type PlanWave } from "./waveSchedule";

// Contract (equivalence): a plan with no `test` field — every plan persisted before test waves — keeps the exact
// pre-tester graph and progress answers. legacyWaveGraph.oracle.json was captured by running snapshot() on the pre-feature code (bf73de5),
// not on this tree, so the same file passes on both. Regression: a missing `test` or an absent wave changes a tip,
// a pending list, the ready step, the review block, the final-wave test, absorption or the progress count.
// This is the one owner of that equivalence; the server tests only cover the new behaviour.

type Row = {
  thread_id: string; role: string; kind: string | null; state: string; last_report_state: string | null; created_at: number;
  plan_thread_id: string | null; plan_wave: number | null; plan_waves: string | null; replaces_thread_id: string | null;
  report_seq: number; branch: string | null; verdict: string | null;
};

const GRAPHS: Record<string, { dependsOn?: number[]; design?: boolean }[]> = {
  "linear three": [{}, {}, {}],
  "two independent chains": [{}, { dependsOn: [] }],
  "two stacked chains": [{}, {}, { dependsOn: [] }, { dependsOn: [3] }],
  "design head": [{ design: true }, {}],
};
// [state of every worker, report state, whether one covering approve review exists]
const STATES: Record<string, [string, string | null, boolean]> = {
  active: ["active", null, false],
  ready: ["ready", "ready", false],
  complete: ["complete", "ready", false],
  idleAfterReady: ["idle", "ready", false],
  reviewed: ["ready", "ready", true],
};
// Which waves have a worker, besides all of them.
const COVERAGE: Record<string, (wave: number, last: number) => boolean> = {
  all: () => true,
  firstOnly: (wave) => wave === 1,
  allButLast: (wave, last) => wave !== last,
};

// Rows are named by thread id and each step's plan-wave list (the input) is dropped, so the oracle stays small.
const norm = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "waves" ? undefined : item && typeof item === "object" && "thread_id" in item ? item.thread_id : item));

function snapshot() {
  const out: Record<string, unknown> = {};
  for (const [graphName, graph] of Object.entries(GRAPHS)) {
    const linked = graph.map((wave, index) => ({ path: `plan-${index + 1}.md`, ...wave }));
    out[`${graphName} | graph`] = {
      successorOf: linked.map((_, i) => successorOf(linked, i + 1)),
      chainOf: linked.map((_, i) => chainOf(linked, i + 1)),
      tips: tips(linked),
      heads: heads(linked),
    };
    for (const [stateName, [state, lastReport, reviewed]] of Object.entries(STATES)) {
      for (const [coverageName, covers] of Object.entries(COVERAGE)) {
        for (const fix of [false, true]) {
          const rows = new Map<string, Row>();
          const base = { role: "planner", kind: null, state: "ready", last_report_state: "ready", created_at: 0, plan_thread_id: null, plan_wave: null, replaces_thread_id: null, report_seq: 1, branch: null, verdict: null };
          rows.set("planner", { ...base, thread_id: "planner", plan_waves: JSON.stringify(graph.map((wave, index) => ({ path: `plan-${index + 1}.md`, ...wave }))) });
          let clock = 1;
          graph.forEach((_, index) => {
            const wave = index + 1;
            if (!covers(wave, graph.length)) return;
            const worker = { ...base, role: "worker", state, last_report_state: lastReport, plan_thread_id: "planner", plan_wave: wave, plan_waves: null };
            rows.set(`w${wave}`, { ...worker, thread_id: `w${wave}`, created_at: clock++ });
            // A same-wave fix worker that replaces the first one on wave 1 (restack).
            if (fix && wave === 1) rows.set("fix1", { ...worker, thread_id: "fix1", state: "ready", last_report_state: "ready", replaces_thread_id: "w1", created_at: clock++ });
          });
          const covering = (threadId: string) => reviewed && rows.get(threadId)?.role === "worker" ? { thread_id: "reviewer", state: "ready", verdict: "approve", target_seq: 1 } : undefined;
          const ledger = { covering, isCurrent: (worker: { thread_id: string; report_seq: number }) => covering(worker.thread_id)?.target_seq === worker.report_seq, targets: () => [] } as any;
          const schedule = createWaveSchedule<Row>(() => rows);
          const progress = createPlanProgress<Row>(() => rows, schedule, ledger, { terminal: (s) => s === "complete", busy: (s) => s === "active" || s === "starting" });
          const graphWaves: PlanWave[] = schedule.planWavesFor("planner");
          const workerIds = [...rows.keys()].filter((id) => id !== "planner");
          out[`${graphName} | ${stateName} | ${coverageName}${fix ? " | fix" : ""}`] = norm({
            absent: graphWaves.flatMap((wave, i) => wave.absent ? [i + 1] : []),
            pendingWaves: schedule.pendingWaves("planner", graphWaves),
            waveProgress: progress.waveProgress(rows.get("planner")!),
            plannerAbsorbed: progress.plannerAbsorbed(rows.get("planner")!),
            workers: Object.fromEntries(workerIds.map((id) => {
              const row = rows.get(id)!;
              return [id, {
                reviewBlock: progress.reviewBlock(row),
                readyStep: progress.readyStep(row),
                readyStepForAlert: progress.readyStep(row, true),
                onFinalWave: schedule.onFinalWave(row),
              }];
            })),
          });
        }
      }
    }
  }
  return out;
}

describe("legacy wave graph", () => {
  test("a plan with no test field answers every graph and progress question as before test waves", () => {
    expect(snapshot()).toEqual(JSON.parse(readFileSync(new URL("./legacyWaveGraph.oracle.json", import.meta.url), "utf8")));
  });
});

