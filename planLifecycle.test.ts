import { describe, expect, test, vi } from "vitest";
import { createPlanLifecycle } from "./src/plan/planLifecycle";
import { createWaveSchedule, type PlanWave } from "./src/plan/waveSchedule";

// Contract: the module is the long-term rule matrix for who may run which plan wave next (role, Spec Writer and tester
// hand-off order, test and spec waivers). Cases are named after the wave 1 plan's case matrix. The caller oracle
// (server.test.ts "plan admission oracle") owns bytes, routing and launch; this file owns each rule once.
// The wave graph is the real createWaveSchedule over in-memory rows; only the task chain and the advisor-review gate are stubs.

type Row = {
  thread_id: string; role: string; kind: string | null; state: string; last_report_state: string | null; created_at: number;
  plan_thread_id: string | null; plan_wave: number | null; plan_waves: string | null; chief_thread_id: string | null;
  report_path: string | null; owner_approval: string | null; brief: string | null; pr_url: string | null;
};
type Worker = { id: string; plan?: string; wave?: number; kind?: string; state?: string; last?: string | null; report?: string; approval?: string; brief?: string; pr?: string };
type Request = Parameters<ReturnType<typeof createPlanLifecycle<Row>>["admitDelegation"]>[0];

const CHIEF = "chief";
let clock = 0;
const base = (thread_id: string, over: Partial<Row>): Row => ({
  thread_id, role: "worker", kind: "worker", state: "ready", last_report_state: "ready", created_at: ++clock, plan_thread_id: null,
  plan_wave: null, plan_waves: null, chief_thread_id: CHIEF, report_path: null, owner_approval: null, brief: null, pr_url: null, ...over,
});

/** plans: planner id -> its waves. workers are created in order (oldest first). taskChain: unplanned prior id -> chain ids, tip to head. */
function world(plans: Record<string, PlanWave[]>, workers: Worker[] = [], taskChain: Record<string, string[]> = {}, reviewRefusal: string | null = null) {
  const rows = new Map<string, Row>();
  for (const [id, waves] of Object.entries(plans)) rows.set(id, base(id, { role: "planner", kind: null, plan_waves: JSON.stringify(waves) }));
  for (const w of workers) {
    rows.set(w.id, base(w.id, {
      kind: w.kind ?? "worker", state: w.state ?? "ready", last_report_state: w.last === undefined ? "ready" : w.last,
      plan_thread_id: w.plan ?? null, plan_wave: w.wave ?? null, report_path: w.report ?? null, owner_approval: w.approval ?? null, brief: w.brief ?? null, pr_url: w.pr ?? null,
    }));
  }
  const review = vi.fn((_planner: Row) => reviewRefusal);
  const lifecycle = createPlanLifecycle<Row>(rows, createWaveSchedule(() => rows), { taskChain: (id) => taskChain[id] ?? [id] }, review);
  const admit = (request: Omit<Partial<Request>, "prior"> & { prior?: string }) => {
    const { prior, ...rest } = request;
    return lifecycle.admitDelegation({ chiefId: CHIEF, resolvedKind: rest.kind ?? "worker", ...rest, prior: prior ? rows.get(prior) : undefined });
  };
  return { rows, review, lifecycle, admit };
}
const P = "plan";
const planned = { planThreadId: P };

describe("admitDelegation: explicitKind and planner gates (order)", () => {
  test("a prior tester or Spec Writer with kind omitted must name the kind", () => {
    for (const kind of ["tester", "spec-writer"]) {
      const { admit } = world({ [P]: [{ path: "w1" }] }, [{ id: "prior", kind }]);
      expect(() => admit({ prior: "prior", resolvedKind: "worker" })).toThrow(/^Name the kind: kind: worker to change product code, kind: tester to change tests, kind: spec-writer to change docs\/\.$/);
    }
  });

  test("double fault: prior tester, kind omitted and a foreign planner gives explicitKind, and the review gate is never called", () => {
    const { rows, admit, review } = world({ [P]: [{ path: "w1" }] }, [{ id: "prior", kind: "tester" }]);
    rows.set("foreign", base("foreign", { role: "planner", chief_thread_id: "other-chief", plan_waves: "[]" }));
    expect(() => admit({ prior: "prior", planThreadId: "foreign", wave: 1, resolvedKind: "worker" })).toThrow(/^Name the kind/);
    expect(() => admit({ prior: "prior", planThreadId: P, wave: 1, resolvedKind: "worker" })).toThrow(/^Name the kind/);
    expect(review).not.toHaveBeenCalled();
  });

  test("a missing, non-planner, foreign or Chief-itself planner is refused as no managed planner", () => {
    const { rows, admit, review } = world({ [P]: [{ path: "w1" }] }, [{ id: "w" }]);
    rows.set("foreign", base("foreign", { role: "planner", chief_thread_id: "other-chief", plan_waves: "[]" }));
    rows.set(CHIEF, base(CHIEF, { role: "planner", chief_thread_id: CHIEF, plan_waves: "[]" }));
    for (const id of ["ghost", "w", "foreign", CHIEF]) {
      expect(() => admit({ planThreadId: id, wave: 1 }), id).toThrow(`No managed planner ${id} for this Chief.`);
    }
    expect(review).not.toHaveBeenCalled();
  });

  test("the planner's advisor-review refusal comes before the wave range check", () => {
    const { admit, review } = world({ [P]: [{ path: "w1" }] }, [], {}, "Planner plan has not been reviewed.");
    expect(() => admit({ ...planned, wave: 9 })).toThrow("Planner plan has not been reviewed.");
    expect(review).toHaveBeenCalledOnce();
    expect(review.mock.calls[0]![0].thread_id).toBe(P);
  });
});

describe("admitDelegation: wave range and absent waves", () => {
  test.each([[undefined, "?"], [0, "0"], [3, "3"]])("wave %s is out of range of a two-wave plan", (wave, shown) => {
    const { admit } = world({ [P]: [{ path: "w1" }, { path: "w2" }] });
    expect(() => admit({ ...planned, wave })).toThrow(`Wave ${shown} is out of range: planner ${P} scheduled 2 wave(s).`);
  });

  test("a test wave waived before any delegation is absent: nothing to delegate", () => {
    const { admit } = world({ [P]: [{ path: "w1" }, { path: "w2", test: true, testsSkipped: "covered elsewhere" }] }, [{ id: "w", plan: P, wave: 1 }]);
    expect(() => admit({ ...planned, wave: 2, prior: "w", kind: "tester", resolvedKind: "tester" })).toThrow("Wave 2's tests were skipped (covered elsewhere); nothing to delegate.");
  });
});

describe("admitDelegation: plan facts handed to the worker brief", () => {
  test("a legacy plan (no dependsOn) chains each wave to the previous one", () => {
    const { admit } = world({ [P]: [{ path: "w1", contracts: "c1" }, { path: "w2", contracts: "c2" }, { path: "w3" }] }, [{ id: "w1", plan: P, wave: 1 }]);
    expect(admit({ ...planned, wave: 2, prior: "w1" })).toMatchObject({
      kind: "worker", planPath: "w2", waveTotal: 3, waveNext: 3, waveIndependent: false, designWave: false, implementsDesign: null, contracts: "c2",
      specSources: [], specDocs: [], baseline: false,
    });
    expect(admit({ ...planned, wave: 3, prior: "w1" }).waveNext).toBeNull();
  });

  test("an independent head (dependsOn: []) is independent only when it starts fresh; replacing a worker of another chain is refused", () => {
    const { admit } = world({ [P]: [{ path: "w1" }, { path: "w2", dependsOn: [] }] }, [{ id: "w1", plan: P, wave: 1 }]);
    expect(admit({ ...planned, wave: 2 }).waveIndependent).toBe(true);
    expect(world({ [P]: [{ path: "w1" }, { path: "w2", dependsOn: [] }] }).admit({ ...planned, wave: 1 }).waveIndependent).toBe(false);
    // Rule (i): the prior works on wave 1, another chain; the old "independent only without a prior" answer is now a refusal.
    expect(() => admit({ ...planned, wave: 2, prior: "w1" })).toThrow(/^Wave 2 belongs to the chain of waves 2; w1 works on wave 1, another chain\./);
  });

  test("unplanned: only kind and the task-chain facts are set", () => {
    const { admit } = world({}, [{ id: "w" }]);
    expect(admit({ prior: "w" })).toEqual({
      kind: "worker", planPath: undefined, waveTotal: undefined, waveNext: null, waveIndependent: false, designWave: false, implementsDesign: null,
      contracts: undefined, specSources: [], specDocs: [], baseline: false,
    });
  });
});

describe("admitDelegation: design waves", () => {
  const waves: PlanWave[] = [{ path: "w1", design: true }, { path: "w2" }];
  test("a design-only wave defaults to a designer; a named kind is kept", () => {
    const { admit } = world({ [P]: waves });
    expect(admit({ ...planned, wave: 1 })).toMatchObject({ kind: "designer", designWave: true });
    expect(admit({ ...planned, wave: 1, kind: "worker", resolvedKind: "worker" })).toMatchObject({ kind: "worker", designWave: true });
  });
  test("the wave that builds on a design wave reports implementsDesign", () => {
    const { admit } = world({ [P]: waves }, [{ id: "d", plan: P, wave: 1, kind: "designer" }]);
    expect(admit({ ...planned, wave: 2, prior: "d" })).toMatchObject({ implementsDesign: 1, designWave: false });
  });
});

describe("admitDelegation: spec flow", () => {
  const specPlan: PlanWave[] = [{ path: "w1", spec: true }, { path: "w2" }, { path: "w3" }];

  test("(a) the replaced row's wave owes its implementation: a not-ready Spec Writer asks for its retry", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", state: "active", last: null }]);
    expect(() => admit({ ...planned, wave: 2, prior: "sw", kind: "worker", resolvedKind: "worker" })).toThrow(/^Wave 1's Spec Writer sw has not reported ready: retry it with the fix — chief_delegate \(planThreadId: plan, wave: 1, replaces: sw, kind: spec-writer\) — or, when the Spec delta cannot be written/);
  });

  test("(a) a ready Spec Writer asks for its worker first", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer" }]);
    expect(() => admit({ ...planned, wave: 2, prior: "sw", kind: "worker", resolvedKind: "worker" })).toThrow("Wave 1's Spec Writer sw is ready: the wave's worker implements against its docs first — chief_delegate (planThreadId: plan, wave: 1, replaces: sw, kind: worker).");
  });

  test("(a) its own wave admits the Spec Writer's retry, and its worker once ready", () => {
    const ready = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer" }]);
    expect(ready.admit({ ...planned, wave: 1, prior: "sw", kind: "spec-writer", resolvedKind: "spec-writer" }).kind).toBe("spec-writer");
    expect(ready.admit({ ...planned, wave: 1, prior: "sw", kind: "worker", resolvedKind: "worker" }).kind).toBe("worker");
    const notReady = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", state: "blocked", last: "blocked" }]);
    expect(notReady.admit({ ...planned, wave: 1, prior: "sw", kind: "spec-writer", resolvedKind: "spec-writer" }).kind).toBe("spec-writer");
    expect(() => notReady.admit({ ...planned, wave: 1, prior: "sw", kind: "worker", resolvedKind: "worker" })).toThrow(/has not reported ready/);
  });

  test("(a) the cross-plan exception: a fresh plan's wave 1 Spec Writer takes over a blocked Spec Writer, not a ready or other one", () => {
    const fresh = (state: string, last: string | null, other = false) => {
      const w = world({ [P]: specPlan, fresh: [{ path: "f1", spec: true }] }, [
        { id: "sw", plan: P, wave: 1, kind: "spec-writer", state, last }, ...(other ? [{ id: "later", plan: P, wave: 1, kind: "spec-writer", state: "ready" }] : []),
      ]);
      return () => w.admit({ planThreadId: "fresh", wave: 1, prior: "sw", kind: "spec-writer", resolvedKind: "spec-writer" });
    };
    expect(fresh("blocked", "blocked")().kind).toBe("spec-writer");
    expect(fresh("idle", "blocked")().kind).toBe("spec-writer");
    expect(fresh("ready", "ready")).toThrow(/is ready: the wave's worker implements/);
    expect(fresh("blocked", "blocked", true)).toThrow(/Wave 1's Spec Writer later/);
  });

  test("(a2) an owed wave admits only its writer's retry, or its ready writer's worker; any other prior is refused", () => {
    const writer = (state: string, last: string | null) => world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", state, last }, { id: "o", plan: P, wave: 2 }]);
    expect(() => writer("active", null).admit({ ...planned, wave: 1 })).toThrow("Wave 1's Spec Writer sw has not reported ready: retry it with the fix — chief_delegate (planThreadId: plan, wave: 1, replaces: sw, kind: spec-writer).");
    expect(() => writer("ready", "ready").admit({ ...planned, wave: 1, prior: "o" })).toThrow("Wave 1's Spec Writer sw is ready: the wave's worker implements against its docs first — chief_delegate (planThreadId: plan, wave: 1, replaces: sw, kind: worker).");
    expect(() => writer("active", null).admit({ ...planned, wave: 1, prior: "sw", kind: "worker", resolvedKind: "worker" })).toThrow(/has not reported ready/);
    expect(writer("idle", "ready").admit({ ...planned, wave: 1, prior: "sw", kind: "designer", resolvedKind: "designer" }).kind).toBe("designer");
  });

  test("(b) a wave that builds on a spec wave, at any depth, waits for that wave's worker", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer" }]);
    for (const wave of [2, 3]) {
      expect(() => admit({ ...planned, wave })).toThrow("Wave 1 still owes its implementation: its Spec Writer sw hands off to its worker first — chief_delegate (planThreadId: plan, wave: 1, replaces: sw, kind: worker).");
    }
  });

  test("(b) once the wave's worker follows its Spec Writer, the next wave is no longer blocked", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer" }, { id: "w", plan: P, wave: 1 }]);
    expect(admit({ ...planned, wave: 2, prior: "w" }).kind).toBe("worker");
  });

  test("(c) a spec wave's first delegation is its Spec Writer: kind omitted becomes one, another kind is refused with the waiver", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "o", plan: "other" }]);
    expect(admit({ ...planned, wave: 1 }).kind).toBe("spec-writer");
    expect(() => admit({ ...planned, wave: 1, kind: "worker", resolvedKind: "worker" })).toThrow("Wave 1 is marked spec: true: its Spec Writer runs before its worker — chief_delegate (planThreadId: plan, wave: 1, kind: spec-writer). To go without, record why: chief_skip_specs (planThreadId: plan, wave: 1, reason).");
    expect(() => admit({ ...planned, wave: 1, prior: "o", kind: "worker", resolvedKind: "worker" })).toThrow(/wave: 1, replaces: o, kind: spec-writer\)\. To go without/);
  });

  test("(c) a bypassed spec wave (specsSkipped) takes a worker", () => {
    const { admit } = world({ [P]: [{ path: "w1", spec: true, specsSkipped: "docs exist" }] });
    expect(admit({ ...planned, wave: 1 }).kind).toBe("worker");
  });

  test("(d) a Spec Writer is refused on a bypassed wave, a design wave and a chain with no spec", () => {
    const { admit } = world({ [P]: [{ path: "w1", spec: true, specsSkipped: "docs exist" }, { path: "w2", design: true, dependsOn: [] }, { path: "w3", dependsOn: [] }] });
    const sw = { ...planned, kind: "spec-writer" as const, resolvedKind: "spec-writer" as const };
    expect(() => admit({ ...sw, wave: 1 })).toThrow("Specs on wave 1 were bypassed (docs exist); no Spec Writer runs on it.");
    expect(() => admit({ ...sw, wave: 2 })).toThrow("Wave 2 is design-only: no Spec Writer runs on it.");
    expect(() => admit({ ...sw, wave: 3 })).toThrow("Wave 3: no spec on this chain, so no Spec Writer runs on it.");
  });

  test("(d) repair: a Spec Writer replaces the latest row of a spec-bearing chain, and only that row", () => {
    const { admit } = world({ [P]: specPlan }, [
      { id: "sw", plan: P, wave: 1, kind: "spec-writer" }, { id: "w", plan: P, wave: 1 }, { id: "w2", plan: P, wave: 2 },
    ]);
    const repair = { ...planned, wave: 1, kind: "spec-writer" as const, resolvedKind: "spec-writer" as const };
    expect(admit({ ...repair, prior: "w" }).kind).toBe("spec-writer");
    expect(() => admit({ ...repair, prior: "sw" })).toThrow("A Spec Writer on wave 1 replaces its latest worker: chief_delegate (planThreadId: plan, wave: 1, replaces: w, kind: spec-writer).");
  });

  test("a Spec Writer's brief never lists Spec Writer reports", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", report: "/r/sw.md" }, { id: "w", plan: P, wave: 1 }]);
    expect(admit({ ...planned, wave: 1, prior: "w", kind: "spec-writer", resolvedKind: "spec-writer" }).specDocs).toEqual([]);
  });

  test("baseline: a Spec Writer on a baseline wave sets it only while every row on the wave is a Spec Writer", () => {
    const waves: PlanWave[] = [{ path: "w1", spec: true, baseline: true }];
    const sw = { ...planned, wave: 1, kind: "spec-writer" as const, resolvedKind: "spec-writer" as const };
    expect(world({ [P]: waves }).admit(sw).baseline).toBe(true);
    expect(world({ [P]: waves }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer" }]).admit({ ...sw, prior: "sw" }).baseline).toBe(true);
    expect(world({ [P]: waves }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer" }, { id: "w", plan: P, wave: 1 }]).admit({ ...sw, prior: "w" }).baseline).toBe(false);
    expect(world({ [P]: [{ path: "w1", spec: true }] }).admit(sw).baseline).toBe(false);
  });

  test("baseline: a tester walks its ancestors; a bypassed baseline wave does not count", () => {
    const tester = (waves: PlanWave[]) => world({ [P]: waves }, [{ id: "w", plan: P, wave: 2 }]).admit({ ...planned, wave: 3, prior: "w", kind: "tester", resolvedKind: "tester" }).baseline;
    expect(tester([{ path: "w1", spec: true, baseline: true, specsSkipped: "x" }, { path: "w2" }, { path: "w3", test: true }])).toBe(false);
    expect(tester([{ path: "w1", spec: true, baseline: true }, { path: "w2" }, { path: "w3", test: true }])).toBe(true);
    expect(tester([{ path: "w1", spec: true }, { path: "w2" }, { path: "w3", test: true }])).toBe(false);
  });

  test("specDocs: a worker on a spec-bearing chain lists each wave's Spec Writer report; a chain without one lists none", () => {
    const withWriter = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", report: "/r/sw.md" }, { id: "w", plan: P, wave: 1 }]);
    expect(withWriter.admit({ ...planned, wave: 2, prior: "w" }).specDocs).toEqual(["Wave 1 Spec Writer sw: report /r/sw.md"]);
    const noReport = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer" }, { id: "w", plan: P, wave: 1 }]);
    expect(noReport.admit({ ...planned, wave: 2, prior: "w" }).specDocs).toEqual(["Wave 1 Spec Writer sw: report none"]);
    expect(world({ [P]: [{ path: "w1" }, { path: "w2" }] }, [{ id: "w", plan: P, wave: 1 }]).admit({ ...planned, wave: 2, prior: "w" }).specDocs).toEqual([]);
  });
});

describe("admitDelegation: test waves", () => {
  const testPlan: PlanWave[] = [{ path: "w1" }, { path: "w2", test: true }];
  const tester = { kind: "tester" as const, resolvedKind: "tester" as const };

  test("the first hand-off replaces the parent worker; kind omitted becomes tester", () => {
    const { admit } = world({ [P]: testPlan }, [{ id: "w", plan: P, wave: 1 }]);
    expect(admit({ ...planned, wave: 2, prior: "w" }).kind).toBe("tester");
  });

  test("no prior, or a prior on another wave or plan, is refused with the hand-off call", () => {
    const { admit } = world({ [P]: testPlan, q: [{ path: "q1" }] }, [{ id: "w", plan: P, wave: 1 }, { id: "x", plan: "q", wave: 1 }]);
    const refusal = "Wave 2 is a test wave: it runs on wave 1's branch. Delegate it as chief_delegate (planThreadId: plan, wave: 2, replaces: w, kind: tester).";
    expect(() => admit({ ...planned, wave: 2 })).toThrow(refusal);
    expect(() => admit({ ...planned, wave: 2, prior: "x" })).toThrow(refusal);
  });

  test("with no parent worker yet, the refusal names a placeholder", () => {
    const { admit } = world({ [P]: testPlan });
    expect(() => admit({ ...planned, wave: 2 })).toThrow("replaces: <wave 1's latest worker>, kind: tester).");
  });

  test("a completed prior is replaced by a tester: no terminal-row refusal", () => {
    const { admit } = world({ [P]: testPlan }, [{ id: "w", plan: P, wave: 1, state: "complete" }]);
    expect(admit({ ...planned, wave: 2, prior: "w", ...tester })).toMatchObject({ kind: "tester", waveNext: null });
    expect(admit({ ...planned, wave: 2, prior: "w" }).kind).toBe("tester");
  });

  test("afterMerge: a fresh tester on its own branch is admitted once the tested worker is complete", () => {
    const done = world({ [P]: testPlan }, [{ id: "w", plan: P, wave: 1, state: "complete" }]);
    expect(done.admit({ ...planned, wave: 2, branch: "b", ...tester }).kind).toBe("tester");
    expect(() => done.admit({ ...planned, wave: 2, ...tester })).toThrow(/is a test wave: it runs on wave 1's branch/);
    const open = world({ [P]: testPlan }, [{ id: "w", plan: P, wave: 1, state: "ready" }]);
    expect(() => open.admit({ ...planned, wave: 2, branch: "b", ...tester })).toThrow(/is a test wave/);
  });

  test("a worker fix on the same wave needs an explicit kind, and kind: worker is admitted there", () => {
    const { admit } = world({ [P]: testPlan }, [{ id: "w", plan: P, wave: 1 }, { id: "t", plan: P, wave: 2, kind: "worker" }]);
    expect(() => admit({ ...planned, wave: 2, prior: "t" })).toThrow(/^Name the kind/);
    expect(admit({ ...planned, wave: 2, prior: "t", kind: "worker", resolvedKind: "worker" }).kind).toBe("worker");
    expect(admit({ ...planned, wave: 2, prior: "t", ...tester }).kind).toBe("tester");
  });

  test("a designer is refused on a test wave; kind: worker is refused unless it replaces a worker on that wave", () => {
    const { admit } = world({ [P]: testPlan }, [{ id: "w", plan: P, wave: 1 }]);
    expect(() => admit({ ...planned, wave: 2, prior: "w", kind: "designer", resolvedKind: "designer" })).toThrow("Wave 2 is a test wave: a designer cannot run it. Use kind: tester, or kind: worker to fix product code on it.");
    expect(() => admit({ ...planned, wave: 2, prior: "w", kind: "worker", resolvedKind: "worker" })).toThrow("Wave 2 is a test wave: its first hand-off is kind: tester. kind: worker only replaces a worker on wave 2, to fix product code.");
  });

  test("a tester on a non-test wave of a plan that has a test wave is refused, naming the test waves", () => {
    const { admit } = world({ [P]: [{ path: "w1" }, { path: "w2" }, { path: "w3", test: true }] }, [{ id: "w", plan: P, wave: 1 }]);
    expect(() => admit({ ...planned, wave: 2, prior: "w", ...tester })).toThrow("Wave 2 is not a test wave: a tester runs only this plan's test waves (3).");
  });

  test("a tester on a plan with no test wave needs a prior or, once the worker is complete, a new branch", () => {
    const plain: PlanWave[] = [{ path: "w1" }];
    const open = world({ [P]: plain }, [{ id: "w", plan: P, wave: 1 }]);
    const refusal = "kind: tester on a plan with no test wave needs replaces: of the worker whose branch it tests, or a new branch once that worker is complete.";
    expect(() => open.admit({ ...planned, wave: 1, ...tester })).toThrow(refusal);
    expect(() => open.admit({ ...planned, wave: 1, branch: "b", ...tester })).toThrow(refusal);
    expect(open.admit({ ...planned, wave: 1, prior: "w", ...tester }).kind).toBe("tester");
    const done = world({ [P]: plain }, [{ id: "w", plan: P, wave: 1, state: "complete" }]);
    expect(done.admit({ ...planned, wave: 1, branch: "b", ...tester }).kind).toBe("tester");
  });
});

describe("admitDelegation: specSources", () => {
  const sourcePlan: PlanWave[] = [{ path: "w1", contracts: "contract one" }, { path: "w2", contracts: "contract two", test: true }];
  const tester = { kind: "tester" as const, resolvedKind: "tester" as const };

  test("a tester lists every wave of its chain with its contracts; a worker lists none", () => {
    const { admit } = world({ [P]: sourcePlan }, [{ id: "w", plan: P, wave: 1 }]);
    expect(admit({ ...planned, wave: 2, prior: "w", ...tester }).specSources).toEqual(["Wave 1 of 2: w1", "contract one", "Wave 2 of 2: w2", "contract two"]);
    expect(world({ [P]: [{ path: "w1" }, { path: "w2", contracts: "c" }] }, [{ id: "w", plan: P, wave: 1 }]).admit({ ...planned, wave: 2, prior: "w" }).specSources).toEqual([]);
  });

  test("a wave without contracts adds only its path line; long contracts are clipped to about 3000 characters", () => {
    const long = "x".repeat(10_000);
    const { admit } = world({ [P]: [{ path: "w1" }, { path: "w2", contracts: long, test: true }] }, [{ id: "w", plan: P, wave: 1 }]);
    const sources = admit({ ...planned, wave: 2, prior: "w", ...tester }).specSources;
    expect(sources[0]).toBe("Wave 1 of 2: w1");
    expect(sources[1]).toBe("Wave 2 of 2: w2");
    expect(sources[2]!.length).toBeLessThan(3_100);
  });

  test("a design wave on the chain adds the owner's approval line, or says none was recorded", () => {
    const waves: PlanWave[] = [{ path: "w1", design: true }, { path: "w2", test: true }];
    const approved = world({ [P]: waves }, [{ id: "d", plan: P, wave: 1, kind: "designer", approval: "ok by owner", report: "/r/d.md" }, { id: "w", plan: P, wave: 2 }]);
    expect(approved.admit({ ...planned, wave: 2, prior: "w", ...tester }).specSources).toContain("Approved design: wave 1's artboards, owner's approval “ok by owner”, designer report /r/d.md");
    const none = world({ [P]: waves }, [{ id: "d", plan: P, wave: 1, kind: "designer" }, { id: "w", plan: P, wave: 2 }]);
    expect(none.admit({ ...planned, wave: 2, prior: "w", ...tester }).specSources).toContain("Approved design: wave 1's artboards, owner's approval “none recorded”, designer report none");
  });
});

describe("admitDelegation: unplanned", () => {
  test("(f) a Spec Writer hands off only to a worker or designer, and only after a ready report", () => {
    const writer = (state: string, last: string | null) => world({}, [{ id: "sw", kind: "spec-writer", state, last }]);
    const ready = writer("ready", "ready");
    expect(ready.admit({ prior: "sw", kind: "worker", resolvedKind: "worker" }).kind).toBe("worker");
    expect(writer("idle", "ready").admit({ prior: "sw", kind: "designer", resolvedKind: "designer" }).kind).toBe("designer");
    expect(ready.admit({ prior: "sw", kind: "spec-writer", resolvedKind: "spec-writer" }).kind).toBe("spec-writer");
    expect(() => ready.admit({ prior: "sw", kind: "tester", resolvedKind: "tester" })).toThrow("Spec Writer sw hands off to its worker: chief_delegate (replaces: sw, kind: worker).");
    const notReady = writer("active", null);
    expect(() => notReady.admit({ prior: "sw", kind: "worker", resolvedKind: "worker" })).toThrow("Spec Writer sw has not reported ready: retry it with the fix — chief_delegate (replaces: sw, kind: spec-writer) — or start a fresh chief_plan with its report in context.");
    expect(() => notReady.admit({ prior: "sw", kind: "tester", resolvedKind: "tester" })).toThrow(/^Spec Writer sw has not reported ready/);
  });

  test("a tester without a prior is refused", () => {
    expect(() => world({}).admit({ kind: "tester", resolvedKind: "tester" })).toThrow("kind: tester on unplanned work needs replaces: of the worker whose branch it tests.");
  });

  test("a tester or Spec Writer reads the chain head's brief as its spec source; a worker does not", () => {
    const { admit } = world({}, [{ id: "head", brief: "the original mission" }, { id: "tip" }], { tip: ["tip", "head"] });
    expect(admit({ prior: "tip", kind: "tester", resolvedKind: "tester" }).specSources).toEqual(["the original mission"]);
    expect(admit({ prior: "tip", kind: "spec-writer", resolvedKind: "spec-writer" }).specSources).toEqual(["the original mission"]);
    expect(admit({ prior: "tip", kind: "worker", resolvedKind: "worker" }).specSources).toEqual([]);
  });

  test("a long head brief is clipped to about 4000 characters", () => {
    const { admit } = world({}, [{ id: "head", brief: "y".repeat(20_000) }, { id: "tip" }], { tip: ["tip", "head"] });
    expect(admit({ prior: "tip", kind: "tester", resolvedKind: "tester" }).specSources[0]!.length).toBeLessThan(4_100);
  });

  test("specDocs lists the chain's Spec Writer reports, none for a Spec Writer's own brief", () => {
    const { admit } = world({}, [
      { id: "sw1", kind: "spec-writer", report: "/r/1.md" }, { id: "sw2", kind: "spec-writer" }, { id: "w" },
    ], { w: ["w", "sw2", "sw1"] });
    expect(admit({ prior: "w" }).specDocs).toEqual(["Spec Writer sw1: report /r/1.md", "Spec Writer sw2: report none"]);
    expect(admit({ prior: "w", kind: "spec-writer", resolvedKind: "spec-writer" }).specDocs).toEqual([]);
  });
});

describe("waiveTests", () => {
  const testPlan: PlanWave[] = [{ path: "w1" }, { path: "w2", test: true }];

  test("a wave that is not a test wave, or does not exist, is refused", () => {
    const { lifecycle } = world({ [P]: testPlan });
    expect(() => lifecycle.waiveTests(P, 1)).toThrow(`Wave 1 of planner ${P} is not a test wave (test: true).`);
    expect(() => lifecycle.waiveTests(P, 5)).toThrow(`Wave 5 of planner ${P} is not a test wave (test: true).`);
  });

  test("before any delegation: no worker, not yet waived, parent named", () => {
    const { lifecycle } = world({ [P]: testPlan });
    expect(lifecycle.waiveTests(P, 2)).toEqual({ latest: undefined, alreadyWaived: false, parent: 1 });
  });

  test("a complete latest worker is refused", () => {
    const { lifecycle } = world({ [P]: testPlan }, [{ id: "t", plan: P, wave: 2, kind: "tester", state: "complete" }]);
    expect(() => lifecycle.waiveTests(P, 2)).toThrow("Wave 2's worker t is complete: nothing left to waive.");
  });

  test("a busy latest worker is returned for the caller's liveness check, not refused here", () => {
    const { lifecycle } = world({ [P]: testPlan }, [{ id: "t", plan: P, wave: 2, kind: "tester", state: "active", last: null }]);
    const result = lifecycle.waiveTests(P, 2);
    expect(result.latest?.thread_id).toBe("t");
    expect(result.alreadyWaived).toBe(false);
  });

  test("an already-waived wave reports it, and still refuses a complete latest worker", () => {
    const waived: PlanWave[] = [{ path: "w1" }, { path: "w2", test: true, testsSkipped: "not needed" }];
    const open = world({ [P]: waived }, [{ id: "t", plan: P, wave: 2, kind: "tester", state: "active", last: null }]);
    expect(open.lifecycle.waiveTests(P, 2)).toMatchObject({ alreadyWaived: true, parent: 1 });
    const done = world({ [P]: waived }, [{ id: "t", plan: P, wave: 2, kind: "tester", state: "complete" }]);
    expect(() => done.lifecycle.waiveTests(P, 2)).toThrow("Wave 2's worker t is complete: nothing left to waive.");
  });

  test("waived before delegation (absent wave) is still a valid repeat", () => {
    const { lifecycle } = world({ [P]: [{ path: "w1" }, { path: "w2", test: true, testsSkipped: "not needed" }] });
    expect(lifecycle.waiveTests(P, 2)).toEqual({ latest: undefined, alreadyWaived: true, parent: 1 });
  });

  test("waived after a tester ran: that tester stays the branch owner", () => {
    const waived: PlanWave[] = [{ path: "w1" }, { path: "w2", test: true, testsSkipped: "late" }];
    const { lifecycle, admit } = world({ [P]: waived }, [{ id: "w", plan: P, wave: 1 }, { id: "t", plan: P, wave: 2, kind: "tester" }]);
    expect(lifecycle.waiveTests(P, 2).latest?.thread_id).toBe("t");
    expect(() => admit({ ...planned, wave: 2, prior: "w", kind: "tester", resolvedKind: "tester" })).not.toThrow();
  });
});

describe("waiveSpecs", () => {
  const specPlan: PlanWave[] = [{ path: "w1" }, { path: "w2", spec: true }, { path: "w3", spec: true, test: true }, { path: "w4", spec: true, design: true, dependsOn: [] }];

  test("a wave that is not a spec implementation wave (no spec, test or design, or missing) is refused", () => {
    const { lifecycle } = world({ [P]: specPlan });
    for (const wave of [1, 3, 4, 9]) {
      expect(() => lifecycle.waiveSpecs(P, wave), `wave ${wave}`).toThrow(`Wave ${wave} of planner ${P} is not a spec: true implementation wave.`);
    }
  });

  test("a spec wave with no worker yet is waived, with its parent", () => {
    const { lifecycle } = world({ [P]: specPlan });
    expect(lifecycle.waiveSpecs(P, 2)).toEqual({ outcome: "waive", parent: 1 });
  });

  test("a spec wave that already has a worker is refused", () => {
    const { lifecycle } = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 2, kind: "spec-writer" }]);
    expect(() => lifecycle.waiveSpecs(P, 2)).toThrow("Wave 2 already has worker sw: chief_skip_specs only bypasses a Spec Writer before the wave's first delegation. Re-plan with a fresh chief_plan instead.");
  });

  test("a repeat after the waiver is idempotent: already-waived, or already-waived-delegated once a worker followed", () => {
    const waived: PlanWave[] = [{ path: "w1" }, { path: "w2", spec: true, specsSkipped: "docs exist" }];
    expect(world({ [P]: waived }).lifecycle.waiveSpecs(P, 2)).toEqual({ outcome: "already-waived", parent: 1 });
    expect(world({ [P]: waived }, [{ id: "w", plan: P, wave: 2 }]).lifecycle.waiveSpecs(P, 2)).toEqual({ outcome: "already-waived-delegated", parent: 1 });
  });
});

// Contract (docs/specs/plan-chains.md "Chain Admission and Delegation", "Pull Request Pinning"): a chain has one worker lineage;
// every later wave continues it with replaces:, a started chain is never started twice, replaces: never crosses chains of one
// plan, and a replacement keeps its prior's pull request. Plan: chain A = waves 1-2, chain B = waves 3-4 (4 is its test wave).
describe("admitDelegation: plan chains", () => {
  const chains: PlanWave[] = [{ path: "w1" }, { path: "w2", dependsOn: [1] }, { path: "w3", dependsOn: [] }, { path: "w4", dependsOn: [3], test: true }];
  const tester = { kind: "tester" as const, resolvedKind: "tester" as const };

  describe("(ii) a non-head wave needs replaces:", () => {
    test("with no worker on its chain yet, the refusal names the chain head to delegate first", () => {
      const { admit } = world({ [P]: chains });
      expect(() => admit({ ...planned, wave: 2 })).toThrow("Wave 2 builds on wave 1: delegate its chain head, wave 1, first (chief_forge_init, then chief_delegate), then continue with replaces: the chain's latest worker.");
    });

    test.each([
      ["the newest worker of the chain", [{ id: "a", plan: P, wave: 1 }, { id: "b", plan: P, wave: 2 }], "b"],
      ["a live worker before a newer finished one", [{ id: "a", plan: P, wave: 1 }, { id: "b", plan: P, wave: 2, state: "complete" }], "a"],
    ] as const)("with a worker on the chain, the refusal names %s", (_name, workers, latest) => {
      const { admit } = world({ [P]: [...chains, { path: "w5", dependsOn: [2] }] }, [...workers]);
      expect(() => admit({ ...planned, wave: 5 })).toThrow(`Wave 5's chain (waves 1, 2, 5) already has worker ${latest} on wave ${latest === "a" ? 1 : 2}; a chain has one branch, PR and worktree. Continue it with replaces: ${latest} — chief_delegate (planThreadId: ${P}, wave: 5, replaces: ${latest}).`);
    });

    test("a legacy plan (no dependsOn) is one chain: wave 2 without replaces: is refused, with it admitted", () => {
      const { admit } = world({ [P]: [{ path: "w1" }, { path: "w2" }, { path: "w3" }] }, [{ id: "w1", plan: P, wave: 1 }]);
      expect(() => admit({ ...planned, wave: 2 })).toThrow(/already has worker w1 on wave 1/);
      expect(() => admit({ ...planned, wave: 3 })).toThrow(/Wave 3's chain \(waves 1, 2, 3\) already has worker w1/);
      expect(admit({ ...planned, wave: 2, prior: "w1" }).planPath).toBe("w2");
    });

    test("the tester naming advice carries kind: tester", () => {
      const { admit } = world({ [P]: chains }, [{ id: "c", plan: P, wave: 3 }]);
      expect(() => admit({ ...planned, wave: 4, ...tester })).toThrow(/is a test wave: it runs on wave 3's branch/);
    });
  });

  describe("(iii) a started chain is never started twice", () => {
    test("a head wave with a worker on its chain, delegated without replaces:, is refused and names that worker", () => {
      const { admit } = world({ [P]: chains }, [{ id: "a", plan: P, wave: 1 }]);
      expect(() => admit({ ...planned, wave: 1 })).toThrow("Wave 1's chain (waves 1, 2) already has worker a on wave 1; a chain has one branch, PR and worktree. Continue it with replaces: a — chief_delegate (planThreadId: plan, wave: 1, replaces: a).");
    });

    test("a worker deeper in the chain also marks the head started", () => {
      const { admit } = world({ [P]: chains }, [{ id: "b", plan: P, wave: 2 }]);
      expect(() => admit({ ...planned, wave: 1 })).toThrow(/already has worker b on wave 2/);
    });

    test("replaces: the chain's own worker is admitted, for any wave of the chain", () => {
      const { admit } = world({ [P]: chains }, [{ id: "a", plan: P, wave: 1 }]);
      expect(admit({ ...planned, wave: 1, prior: "a" }).planPath).toBe("w1");
      expect(admit({ ...planned, wave: 2, prior: "a" }).planPath).toBe("w2");
    });

    test("a head wave with no worker on its chain starts fresh, whatever other chains already run", () => {
      const { admit } = world({ [P]: chains }, [{ id: "a", plan: P, wave: 1 }]);
      expect(admit({ ...planned, wave: 3 })).toMatchObject({ planPath: "w3", waveIndependent: true });
    });

    test("a tester may still start fresh on a new branch once the tested worker is complete (afterMerge)", () => {
      const { admit } = world({ [P]: chains }, [{ id: "c", plan: P, wave: 3, state: "complete" }]);
      expect(admit({ ...planned, wave: 4, branch: "post-merge", ...tester }).kind).toBe("tester");
      expect(() => admit({ ...planned, wave: 4, ...tester })).toThrow(/is a test wave/);
    });
  });

  describe("(i) replaces: never crosses chains of one plan", () => {
    test("a worker of chain A cannot be replaced into chain B's head; the refusal names chief_forge_init on the head", () => {
      const { admit } = world({ [P]: chains }, [{ id: "a", plan: P, wave: 1 }]);
      expect(() => admit({ ...planned, wave: 3, prior: "a" })).toThrow("Wave 3 belongs to the chain of waves 3, 4; a works on wave 1, another chain. An independent chain starts its own branch with chief_forge_init on its head wave 3, or replaces that chain's latest worker.");
    });

    test("when chain B already runs, the refusal names its latest worker instead", () => {
      const { admit } = world({ [P]: chains }, [{ id: "a", plan: P, wave: 1 }, { id: "c", plan: P, wave: 3 }]);
      expect(() => admit({ ...planned, wave: 3, prior: "a" })).toThrow("another chain. An independent chain starts its own branch with chief_forge_init on its head wave 3, or replaces that chain's latest worker — chief_delegate (planThreadId: plan, wave: 3, replaces: c).");
    });

    test("the refusal comes before the pull request check, whichever URL is passed", () => {
      const { admit } = world({ [P]: chains }, [{ id: "a", plan: P, wave: 1, pr: "https://h/pull/1" }]);
      expect(() => admit({ ...planned, wave: 3, prior: "a", prUrl: "https://h/pull/2" })).toThrow(/another chain/);
    });

    test("a worker of another plan is not a cross-chain prior: the fresh-plan wave 1 escape stays open", () => {
      const { admit, rows } = world({ [P]: chains }, [{ id: "old", plan: "other", wave: 1, state: "blocked", last: "blocked" }]);
      rows.set("other", base("other", { role: "planner", kind: null, plan_waves: JSON.stringify([{ path: "o1" }, { path: "o2" }]) }));
      expect(admit({ ...planned, wave: 1, prior: "old" }).planPath).toBe("w1");
    });
  });

  describe("(iv) a replacement keeps its prior's pull request", () => {
    const pr = "https://github.com/acme/shop/pull/7";
    const pinned = () => world({ [P]: chains }, [{ id: "a", plan: P, wave: 1, pr }]);

    test("a different prUrl on a replacement is refused, naming both the worker and the pull request", () => {
      expect(() => pinned().admit({ ...planned, wave: 2, prior: "a", prUrl: "https://github.com/acme/shop/pull/8" })).toThrow(`replaces: a carries pull request ${pr}; pass no prUrl or the same one. A plan chain has one pull request.`);
    });

    test("the same prUrl, or none, is admitted", () => {
      expect(pinned().admit({ ...planned, wave: 2, prior: "a", prUrl: pr }).planPath).toBe("w2");
      expect(pinned().admit({ ...planned, wave: 2, prior: "a" }).planPath).toBe("w2");
    });

    test("a prior with no recorded pull request accepts a prUrl", () => {
      const { admit } = world({ [P]: chains }, [{ id: "a", plan: P, wave: 1 }]);
      expect(admit({ ...planned, wave: 2, prior: "a", prUrl: pr }).planPath).toBe("w2");
    });

    test("an unplanned delegation is not pinned: no planThreadId, no pull request check", () => {
      const { admit } = world({}, [{ id: "w", pr }]);
      expect(admit({ prior: "w", prUrl: "https://github.com/acme/shop/pull/9" }).kind).toBe("worker");
    });
  });
});
