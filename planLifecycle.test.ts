import { describe, expect, test, vi } from "vitest";
import { createPlanLifecycle } from "./src/plan/planLifecycle";
import { createWaveSchedule, type PlanWave } from "./src/plan/waveSchedule";

// Contract: the module is the long-term rule matrix for who may run which plan wave next (role, Spec Writer and tester
// hand-off order, spec waivers). Cases are named after the wave 1 plan's case matrix. The caller oracle
// (server.test.ts "plan admission oracle") owns bytes, routing and launch; this file owns each rule once.
// The wave graph is the real createWaveSchedule over in-memory rows; only the task chain and the advisor-review gate are stubs.

type Row = {
  thread_id: string; role: string; kind: string | null; state: string; last_report_state: string | null; created_at: number;
  plan_thread_id: string | null; plan_wave: number | null; plan_waves: string | null; chief_thread_id: string | null;
  report_path: string | null; owner_approval: string | null; brief: string | null; pr_url: string | null; replaces_thread_id: string | null; branch: string | null;
};
type Worker = { id: string; plan?: string; wave?: number; kind?: string; state?: string; last?: string | null; report?: string; approval?: string; brief?: string; pr?: string; replaces?: string; branch?: string };
type Request = Parameters<ReturnType<typeof createPlanLifecycle<Row>>["admitDelegation"]>[0];

const CHIEF = "chief";
const CHAIN = "feature/chain";
let clock = 0;
const base = (thread_id: string, over: Partial<Row>): Row => ({
  thread_id, role: "worker", kind: "worker", state: "ready", last_report_state: "ready", created_at: ++clock, plan_thread_id: null,
  plan_wave: null, plan_waves: null, chief_thread_id: CHIEF, report_path: null, owner_approval: null, brief: null, pr_url: null, replaces_thread_id: null, branch: null, ...over,
});

/** plans: planner id -> its waves. workers are created in order (oldest first). taskChain: unplanned prior id -> chain ids, tip to head. */
function world(plans: Record<string, PlanWave[]>, workers: Worker[] = [], taskChain: Record<string, string[]> = {}, reviewRefusal: string | null = null) {
  const rows = new Map<string, Row>();
  for (const [id, waves] of Object.entries(plans)) rows.set(id, base(id, { role: "planner", kind: null, plan_waves: JSON.stringify(waves) }));
  for (const w of workers) {
    rows.set(w.id, base(w.id, {
      kind: w.kind ?? "worker", state: w.state ?? "ready", last_report_state: w.last === undefined ? "ready" : w.last,
      plan_thread_id: w.plan ?? null, plan_wave: w.wave ?? null, report_path: w.report ?? null, owner_approval: w.approval ?? null, brief: w.brief ?? null, pr_url: w.pr ?? null, replaces_thread_id: w.replaces ?? null, branch: w.branch ?? (w.plan ? CHAIN : null),
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

  test("a legacy test wave with no row is absent: the tester runs in the review gate, nothing to delegate", () => {
    const { admit } = world({ [P]: [{ path: "w1" }, { path: "w2", test: true }] }, [{ id: "w", plan: P, wave: 1 }]);
    expect(() => admit({ ...planned, wave: 2, prior: "w" })).toThrow("Wave 2 is a legacy test wave: the tester runs in the review gate (chief_review); nothing to delegate.");
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
      contracts: undefined, specSources: [], specDocs: [], baseline: false, specWave: false, lane: "implementation",
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

// Contract (docs/specs/plan-chains.md "Spec Writer Side Lane"): a spec wave's Spec Writer runs beside its worker. A first side-lane
// writer needs an explicit kind: spec-writer; the call order of writer and worker is free; a writer never gates a later
// implementation wave, only the review; a repair stays in the side lane; legacy sequential rows keep their
// hand-off. Regression: the writer-first rules (the writer as the wave's first row, the worker replacing it, a writer-gated
// wave 2) come back.
describe("admitDelegation: spec flow", () => {
  const specPlan: PlanWave[] = [{ path: "w1", spec: true }, { path: "w2" }, { path: "w3" }];
  const writer = { ...planned, kind: "spec-writer" as const, resolvedKind: "spec-writer" as const, branch: CHAIN };

  test("a spec wave's first hand-off defaults to a worker, and an explicit worker, designer or Spec Writer is kept", () => {
    const { admit } = world({ [P]: specPlan });
    expect(admit({ ...planned, wave: 1 })).toMatchObject({ kind: "worker", lane: "implementation" });
    expect(admit({ ...planned, wave: 1, kind: "worker", resolvedKind: "worker" })).toMatchObject({ kind: "worker", lane: "implementation" });
    expect(admit({ ...planned, wave: 1, kind: "designer", resolvedKind: "designer" }).kind).toBe("designer");
    expect(() => admit({ ...writer, wave: 1 })).toThrow("wave(s) 1, 2, 3 of 3 are not ready yet");
  });

  test("the plan's Spec Writer cuts from the chain owner's branch, and no other", () => {
    const { admit } = world({ [P]: [{ path: "w1", spec: true }] }, [{ id: "w", plan: P, wave: 1, pr: "https://pr/1" }]);
    expect(admit({ ...writer, wave: 1, branch: undefined }).sideChain).toEqual({ branch: CHAIN, prUrl: "https://pr/1" });
    expect(() => admit({ ...writer, wave: 1, branch: "feature/other" })).toThrow(`branch feature/other is not the chain's branch ${CHAIN} (worker w); a Spec Writer folds onto the chain's one branch.`);
  });

  test("the first plan writer waits for every chain, then owns the last spec wave even when a later wave exists", () => {
    const waves: PlanWave[] = [
      { path: "w1", spec: true, baseline: true, contracts: "worker-only contract" },
      { path: "w2", spec: true, dependsOn: [] },
      { path: "w3", dependsOn: [2] },
    ];
    const rows: Worker[] = [
      { id: "w1", plan: P, wave: 1, state: "complete" },
      { id: "w2", plan: P, wave: 2, state: "complete" },
    ];
    const pending = world({ [P]: waves }, rows);
    expect(() => pending.admit({ ...writer, wave: 1 })).toThrow("chief_delegate (planThreadId: plan, wave: 2, kind: spec-writer)");
    expect(() => pending.admit({ ...writer, wave: 2 })).toThrow("wave(s) 3 of 3 are not ready yet");
    const ready = world({ [P]: waves }, [...rows, { id: "w3", plan: P, wave: 3, replaces: "w2", state: "ready" }]);
    expect(ready.admit({ ...writer, wave: 2 })).toMatchObject({ lane: "side", baseline: true, specSources: ["Wave 1 of 3: w1", "Wave 2 of 3: w2", "Wave 3 of 3: w3"] });
  });

  test("legacy: the worker never replaces an active side writer", () => {
    const writerFirst = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", state: "active", last: null }]);
    expect(writerFirst.admit({ ...planned, wave: 1 })).toMatchObject({ kind: "worker", lane: "implementation" });
    expect(writerFirst.admit({ ...planned, wave: 1, kind: "designer", resolvedKind: "designer" }).lane).toBe("implementation");
    const workerFirst = world({ [P]: specPlan }, [{ id: "w", plan: P, wave: 1, state: "active", last: null }]);
    expect(() => workerFirst.admit({ ...writer, wave: 1 })).toThrow("wave(s) 1, 2, 3 of 3 are not ready yet");
    // a worker never takes the writer's place while it works; only its docs fix does
    expect(() => writerFirst.admit({ ...planned, wave: 1, prior: "sw", kind: "worker", resolvedKind: "worker" })).toThrow(/only its docs fix replaces it — chief_delegate \(planThreadId: plan, wave: 1, replaces: sw, kind: spec-writer\)/);
    expect(() => workerFirst.admit({ ...planned, wave: 1 })).toThrow(/already has worker w on wave 1/);
  });

  test("the plan's Spec Writer is refused with a live side writer on the wave, while a wave is not ready, or on a wave that takes none", () => {
    const live = world({ [P]: [{ path: "w1", spec: true }] }, [{ id: "w", plan: P, wave: 1 }, { id: "sw", plan: P, wave: 1, kind: "spec-writer", state: "active", last: null }]);
    expect(() => live.admit({ ...writer, wave: 1 })).toThrow("is still live");
    // The writer waits on its own wave's worker too: wave 2 not ready refuses it, a ready, idle or complete one admits it.
    for (const [state, last] of [["active", null], ["blocked", "blocked"]] as const) {
      const behind = world({ [P]: [{ path: "w1" }, { path: "w2", spec: true }] }, [{ id: "w", plan: P, wave: 1 }, { id: "w2", plan: P, wave: 2, replaces: "w", state, last }]);
      expect(() => behind.admit({ ...writer, wave: 2 }), state).toThrow("wave(s) 2 of 2 are not ready yet");
    }
    for (const [state, last] of [["ready", "ready"], ["idle", "ready"], ["complete", null]] as const) {
      const parent = world({ [P]: [{ path: "w1" }, { path: "w2", spec: true }] }, [{ id: "w", plan: P, wave: 1 }, { id: "w2", plan: P, wave: 2, replaces: "w", state, last }]);
      expect(parent.admit({ ...writer, wave: 2 }), state).toMatchObject({ kind: "spec-writer", lane: "side" });
    }
    const none = world({ [P]: [{ path: "w1", spec: true, specsSkipped: "docs exist" }, { path: "w2", design: true, dependsOn: [] }, { path: "w3", dependsOn: [] }] });
    // A waived spec wave and a no-spec wave now take an implementation-lane writer: with no worker on the chain yet there is no owner to replace.
    expect(() => none.admit({ ...writer, wave: 1 })).toThrow("no worker has started wave 1's chain yet");
    expect(() => none.admit({ ...writer, wave: 2 })).toThrow("Wave 2 is design-only: it changes no repository files. Route its docs need to wave");
    expect(() => none.admit({ ...writer, wave: 3 })).toThrow("no worker has started wave 3's chain yet");
  });

  test("a later implementation wave is admitted while a writer is pending, in every writer state", () => {
    for (const [state, last] of [["active", null], ["blocked", "blocked"], ["ready", "ready"], ["complete", null]] as const) {
      const { admit } = world({ [P]: specPlan }, [{ id: "w", plan: P, wave: 1 }, { id: "sw", plan: P, wave: 1, kind: "spec-writer", state, last }]);
      for (const wave of [2, 3]) expect(admit({ ...planned, wave, prior: "w" }), `${state} wave ${wave}`).toMatchObject({ kind: "worker", lane: "implementation" });
    }
    // The chain's second wave continues the implementation owner, not the writer.
    const { admit } = world({ [P]: specPlan }, [{ id: "w", plan: P, wave: 1 }, { id: "sw", plan: P, wave: 1, kind: "spec-writer", state: "active", last: null }]);
    expect(() => admit({ ...planned, wave: 2 })).toThrow(/Continue it with replaces: w — chief_delegate \(planThreadId: plan, wave: 2, replaces: w\)/);
  });

  test("a docs repair replaces a side writer with kind spec-writer; another kind is refused naming the chain owner", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "w", plan: P, wave: 1 }, { id: "sw", plan: P, wave: 1, kind: "spec-writer", state: "blocked", last: "blocked" }]);
    expect(admit({ ...writer, wave: 1, prior: "sw" })).toMatchObject({ kind: "spec-writer", lane: "side" });
    for (const kind of ["worker", "designer", "tester"] as const) {
      expect(() => admit({ ...planned, wave: 1, prior: "sw", kind, resolvedKind: kind }), kind).toThrow(/replaces: w\b/);
    }
  });

  test("a repair of a ready side writer is also a side writer, and an earlier side writer is not the repair's prior", () => {
    const { admit } = world({ [P]: specPlan }, [{ id: "w", plan: P, wave: 1 }, { id: "sw", plan: P, wave: 1, kind: "spec-writer" }]);
    expect(admit({ ...writer, wave: 1, prior: "sw" }).lane).toBe("side");
    expect(admit({ ...writer, wave: 1, prior: "w" })).toMatchObject({ kind: "spec-writer", lane: "implementation" });
  });

  test("legacy: a ready head writer with no implementation row is replaced by a worker or designer, once only", () => {
    const head = (state: string, last: string | null) => world({ [P]: specPlan }, [{ id: "s1", plan: P, wave: 1, kind: "spec-writer", state, last }]);
    expect(head("ready", "ready").admit({ ...planned, wave: 1, prior: "s1", kind: "worker", resolvedKind: "worker" })).toMatchObject({ kind: "worker", lane: "implementation" });
    expect(head("idle", "ready").admit({ ...planned, wave: 1, prior: "s1", kind: "designer", resolvedKind: "designer" }).kind).toBe("designer");
    expect(() => head("active", null).admit({ ...planned, wave: 1, prior: "s1", kind: "worker", resolvedKind: "worker" })).toThrow();
    const handed = world({ [P]: specPlan }, [{ id: "s1", plan: P, wave: 1, kind: "spec-writer" }, { id: "w1", plan: P, wave: 1 }]);
    expect(() => handed.admit({ ...planned, wave: 1, prior: "s1", kind: "worker", resolvedKind: "worker" })).toThrow(/replaces: w1\b/);
  });

  test("legacy: S1→W1→S2→W2 leaves no wave pending, and S2 that replaced W1 is an implementation row handed off normally", () => {
    const rows: Worker[] = [
      { id: "s1", plan: P, wave: 1, kind: "spec-writer", state: "complete", last: null },
      { id: "w1", plan: P, wave: 1, state: "complete", last: null, replaces: "s1" },
      { id: "s2", plan: P, wave: 1, kind: "spec-writer", state: "complete", last: null, replaces: "w1" },
      { id: "w2", plan: P, wave: 1, state: "active", last: null, replaces: "s2" },
    ];
    const { admit, rows: all } = world({ [P]: [{ path: "w1", spec: true }, { path: "w2" }] }, rows);
    const schedule = createWaveSchedule(() => all);
    const planWaves: PlanWave[] = [{ path: "w1", spec: true }, { path: "w2" }];
    expect(schedule.laneOf(all.get("s1")!)).toBe("side");
    expect(schedule.laneOf(all.get("s2")!)).toBe("implementation");
    expect(schedule.writerPending(P, planWaves, 1)).toBe(false);
    expect(schedule.specWriters(P, 1).map((row) => row.thread_id)).toEqual(["s1"]);
    expect(schedule.waveWorkers(P, 1).map((row) => row.thread_id)).toEqual(["w1", "s2", "w2"]);
    expect(schedule.chainOwner(P, planWaves, 1)?.thread_id).toBe("w2");
    // a ready S2 that replaced W1 is handed off as the implementation row
    const inFlight = world({ [P]: specPlan }, [
      { id: "w1", plan: P, wave: 1, state: "complete", last: null },
      { id: "s2", plan: P, wave: 1, kind: "spec-writer", replaces: "w1" },
    ]);
    expect(inFlight.admit({ ...planned, wave: 1, prior: "s2", kind: "worker", resolvedKind: "worker" })).toMatchObject({ kind: "worker", lane: "implementation" });
    expect(inFlight.admit({ ...planned, wave: 2, prior: "s2", kind: "worker", resolvedKind: "worker" }).kind).toBe("worker");
  });

  test("the cross-plan exception keeps per lane: a fresh plan's wave 1 Spec Writer takes over a blocked one, never a ready one", () => {
    const fresh = (state: string, last: string | null) => {
      const w = world({ [P]: specPlan, fresh: [{ path: "f1", spec: true }] }, [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", state, last }]);
      return () => w.admit({ planThreadId: "fresh", wave: 1, prior: "sw", kind: "spec-writer", resolvedKind: "spec-writer" });
    };
    expect(fresh("blocked", "blocked")().kind).toBe("spec-writer");
    expect(fresh("idle", "blocked")().kind).toBe("spec-writer");
    expect(fresh("ready", "ready")).toThrow();
  });

  test("a bypassed spec wave takes a worker", () => {
    const { admit } = world({ [P]: [{ path: "w1", spec: true, specsSkipped: "docs exist" }] });
    expect(admit({ ...planned, wave: 1 }).kind).toBe("worker");
  });

  test("a Spec Writer repair after a worker (implementation lane) replaces the chain owner only", () => {
    const { admit } = world({ [P]: [{ path: "w1", spec: true }, { path: "w2" }] }, [{ id: "w", plan: P, wave: 1 }, { id: "t", plan: P, wave: 2, replaces: "w" }, { id: "sw", plan: P, wave: 1, kind: "spec-writer" }]);
    expect(admit({ ...writer, wave: 2, prior: "t" })).toMatchObject({ kind: "spec-writer", lane: "implementation" });
    expect(() => admit({ ...writer, wave: 2, prior: "w" })).toThrow(/replaces the chain's current implementation row: chief_delegate \(planThreadId: plan, wave: 2, replaces: t, kind: spec-writer\)/);
  });

  test("baseline: the plan's Spec Writer and its repair set it on a baseline wave; a worker, or a wave without the flag, does not", () => {
    const waves: PlanWave[] = [{ path: "w1", spec: true, baseline: true }];
    const w = { id: "w", plan: P, wave: 1 };
    expect(world({ [P]: waves }, [w]).admit({ ...writer, wave: 1 }).baseline).toBe(true);
    expect(world({ [P]: waves }, [w, { id: "sw", plan: P, wave: 1, kind: "spec-writer" }]).admit({ ...writer, wave: 1, prior: "sw" }).baseline).toBe(true);
    expect(world({ [P]: waves }).admit({ ...planned, wave: 1 }).baseline).toBe(false);
    expect(world({ [P]: [{ path: "w1", spec: true }] }, [w]).admit({ ...writer, wave: 1 }).baseline).toBe(false);
  });

  test("specDocs: a worker on the spec wave lists none, and a later wave's worker lists the chain's Spec Writers with the report path", () => {
    const rows: Worker[] = [{ id: "sw", plan: P, wave: 1, kind: "spec-writer", report: "/r/sw.md" }, { id: "w", plan: P, wave: 1 }];
    expect(world({ [P]: specPlan }, rows).admit({ ...planned, wave: 1, prior: "w" }).specDocs).toEqual([]);
    expect(world({ [P]: specPlan }, rows).admit({ ...planned, wave: 2, prior: "w" }).specDocs).toEqual(["Wave 1 Spec Writer sw: report /r/sw.md"]);
  });
});

describe("admitDelegation: tester kind", () => {
  const tester = { kind: "tester" as const, resolvedKind: "tester" as const };
  const plan: PlanWave[] = [{ path: "w1" }, { path: "w2" }];

  test("a tester on a plan needs replaces: of the worker whose branch it tests; a completed prior is replaced without a terminal-row refusal", () => {
    const { admit } = world({ [P]: plan }, [{ id: "w", plan: P, wave: 1, state: "complete" }]);
    expect(() => admit({ ...planned, wave: 1, ...tester })).toThrow("kind: tester on a plan needs replaces: of the worker whose branch it tests.");
    expect(() => admit({ ...planned, wave: 1, branch: "b", ...tester })).toThrow("kind: tester on a plan needs replaces: of the worker whose branch it tests.");
    expect(admit({ ...planned, wave: 1, prior: "w", ...tester })).toMatchObject({ kind: "tester", lane: "implementation" });
  });

  test("a worker fix replacing a tester needs an explicit kind, and kind: worker is admitted there", () => {
    const { admit } = world({ [P]: plan }, [{ id: "w", plan: P, wave: 1 }, { id: "t", plan: P, wave: 1, kind: "tester" }]);
    expect(() => admit({ ...planned, wave: 1, prior: "t" })).toThrow(/^Name the kind/);
    expect(admit({ ...planned, wave: 1, prior: "t", kind: "worker", resolvedKind: "worker" }).kind).toBe("worker");
  });
});

describe("admitDelegation: specSources", () => {
  // Contract (docs/specs/plan-chains.md: one Spec Writer per plan): the plan's Spec Writer lists every wave's path and no wave's contracts,
  // which belong to the worker and the tester. Regression: a contracts clip, or only the writer's own wave, comes back.
  test("the plan's Spec Writer lists every wave's path of a four-wave chain and no contracts", () => {
    const chain: PlanWave[] = [1, 2, 3, 4].map((n) => ({ path: `w${n}`, contracts: `contracts of wave ${n} ${"x".repeat(4_000)}`, spec: true }));
    const rows: Worker[] = [1, 2, 3, 4].map((n) => ({ id: `w${n}`, plan: P, wave: n, ...(n > 1 ? { replaces: `w${n - 1}` } : {}) }));
    const sources = world({ [P]: chain }, rows).admit({ ...planned, wave: 4, kind: "spec-writer", resolvedKind: "spec-writer", branch: undefined }).specSources;
    expect(sources).toEqual([1, 2, 3, 4].map((n) => `Wave ${n} of 4: w${n}`));
  });

  test("a design wave on the chain adds the owner's approval line, or says none was recorded", () => {
    const waves: PlanWave[] = [{ path: "w1", design: true }, { path: "w2", spec: true }];
    const writer = { ...planned, wave: 2, kind: "spec-writer" as const, resolvedKind: "spec-writer" as const, branch: undefined };
    const approved = world({ [P]: waves }, [{ id: "d", plan: P, wave: 1, kind: "designer", approval: "ok by owner", report: "/r/d.md" }, { id: "w", plan: P, wave: 2 }]);
    expect(approved.admit(writer).specSources).toContain("Approved design: wave 1's artboards, owner's approval “ok by owner”, designer report /r/d.md");
    const none = world({ [P]: waves }, [{ id: "d", plan: P, wave: 1, kind: "designer" }, { id: "w", plan: P, wave: 2 }]);
    expect(none.admit(writer).specSources).toContain("Approved design: wave 1's artboards, owner's approval “none recorded”, designer report none");
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
    const { admit } = world({});
    expect(() => admit({ kind: "tester", resolvedKind: "tester" })).toThrow(/replaces:.*or branch/);
    expect(() => admit({ kind: "tester", resolvedKind: "tester", branch: "feature/existing" })).not.toThrow();
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

describe("waiveSpecs", () => {
  const specPlan: PlanWave[] = [{ path: "w1" }, { path: "w2", spec: true }, { path: "w3" }, { path: "w4", spec: true, design: true, dependsOn: [] }];

  test("a plan without a spec implementation wave is refused", () => {
    const { lifecycle } = world({ [P]: specPlan.filter((_, i) => i !== 1) });
    expect(() => lifecycle.waiveSpecs(P)).toThrow(/has no spec: true implementation wave/);
  });

  test("a plan waiver selects spec waves across chains without waiving an existing legacy writer", () => {
    const waves: PlanWave[] = [...specPlan, { path: "anchor", spec: true, dependsOn: [] }];
    expect(world({ [P]: waves }).lifecycle.waiveSpecs(P)).toEqual({ outcome: "waive", waves: [2, 5] });
    const legacy = world({ [P]: waves }, [{ id: "sw", plan: P, wave: 2, kind: "spec-writer" }]);
    expect(legacy.lifecycle.waiveSpecs(P)).toEqual({ outcome: "waive", waves: [5] });
  });

  test("a spec wave that already has a Spec Writer row is refused, and one that only has its worker is waived", () => {
    const { lifecycle } = world({ [P]: specPlan }, [{ id: "sw", plan: P, wave: 2, kind: "spec-writer" }]);
    expect(() => lifecycle.waiveSpecs(P)).toThrow(/fix its docs/i);
    const workerOnly = world({ [P]: specPlan }, [{ id: "w", plan: P, wave: 2 }]);
    expect(workerOnly.lifecycle.waiveSpecs(P)).toEqual({ outcome: "waive", waves: [2] });
  });

  test("a repeated chief_skip_specs remains a no-op with a retained ready legacy writer", () => {
    const waived: PlanWave[] = [{ path: "w1", spec: true }, { path: "w2", spec: true, specsSkipped: "docs exist" }];
    const { lifecycle } = world({ [P]: waived }, [{ id: "legacy", plan: P, wave: 1, kind: "spec-writer" }]);
    expect(lifecycle.waiveSpecs(P)).toEqual({ outcome: "already-waived", waves: [] });
  });
});

// Contract (docs/specs/plan-chains.md "Chain Admission and Delegation", "Pull Request Pinning"): a chain has one worker lineage;
// every later wave continues it with replaces:, a started chain is never started twice, replaces: never crosses chains of one
// plan, and a replacement keeps its prior's pull request. Plan: chain A = waves 1-2, chain B = waves 3-4 (4 is its test wave).
describe("admitDelegation: plan chains", () => {
  const chains: PlanWave[] = [{ path: "w1" }, { path: "w2", dependsOn: [1] }, { path: "w3", dependsOn: [] }, { path: "w4", dependsOn: [3] }];
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

// Contract (docs/specs/plan-chains.md "### Docs Ownership", C3 and C10): "the Spec Writers of this task" is one definition, and every
// non-design plan wave has a legal Spec Writer route that replaces the chain's current implementation row. Regression: taskWriters
// returns a writer of another plan, chain or unplanned task (a foreign writer then excuses a docs commit); the route is refused on a
// non-spec or waived wave again; the route is admitted behind a non-owner row (a second row on the checkout).
describe("docs ownership: taskWriters (C3)", () => {
  const plans = {
    [P]: [{ path: "w1", spec: true }, { path: "w2" }, { path: "w3", spec: true, dependsOn: [] }] as PlanWave[],
    other: [{ path: "o1", spec: true }] as PlanWave[],
  };
  const ids = (writers: { thread_id: string }[]) => writers.map((row) => row.thread_id).sort();
  const writersOf = (rows: Map<string, Row>, id: string, chain: string[]) => createWaveSchedule(() => rows).taskWriters(rows.get(id)!, chain);

  test("a planned task gets the side writers on its chain's waves and the writers of its replaces chain, once each, and never a writer of another chain or plan", () => {
    const { rows } = world(plans, [
      { id: "w", plan: P, wave: 1 }, { id: "sw1", plan: P, wave: 1, kind: "spec-writer", state: "blocked", last: "blocked" },
      { id: "w2", plan: P, wave: 2, replaces: "w" }, { id: "iw", plan: P, wave: 2, kind: "spec-writer", replaces: "w2" },
      { id: "w3", plan: P, wave: 3 }, { id: "sw3", plan: P, wave: 3, kind: "spec-writer" },
      { id: "ow", plan: "other", wave: 1 }, { id: "sw-other", plan: "other", wave: 1, kind: "spec-writer" },
    ]);
    // sw1 is both a side writer of the chain and listed in the replaces chain: it counts once.
    expect(ids(writersOf(rows, "w2", ["w2", "w", "sw1", "iw"]))).toEqual(["iw", "sw1"]);
    // Without the replaces chain only the side-lane writers of waves 1 and 2 remain; the implementation-lane writer needs the chain.
    expect(ids(writersOf(rows, "w2", ["w2"]))).toEqual(["sw1"]);
    // Wave 3 is its own chain: wave 1's writer is not its writer, and its own is.
    expect(ids(writersOf(rows, "w3", ["w3"]))).toEqual(["sw3"]);
    expect(ids(writersOf(rows, "w", ["w"]))).toEqual(["sw1"]);
    expect(ids(writersOf(rows, "ow", ["ow"]))).toEqual(["sw-other"]);
  });

  test("an unplanned task gets only the writers of its own replaces chain, never another unplanned task's writer", () => {
    const { rows } = world({}, [
      { id: "u", kind: "worker" }, { id: "uw", kind: "spec-writer", replaces: "u" },
      { id: "x", kind: "worker" }, { id: "xw", kind: "spec-writer", replaces: "x" },
    ]);
    expect(ids(writersOf(rows, "u", ["u", "uw"]))).toEqual(["uw"]);
    expect(ids(writersOf(rows, "x", ["x", "xw"]))).toEqual(["xw"]);
    expect(writersOf(rows, "u", ["u"])).toEqual([]);
  });
});

describe("docs ownership: the implementation-lane Spec Writer route (C10)", () => {
  const route = (waves: PlanWave[], workers: { id: string; wave: number; kind?: string; replaces?: string }[], wave: number, prior: string) =>
    world({ [P]: waves }, workers.map((w) => ({ ...w, plan: P }))).admit({ ...planned, kind: "spec-writer", resolvedKind: "spec-writer", branch: CHAIN, wave, prior });

  test.each([
    ["a non-spec wave", [{ path: "w1" }, { path: "w2" }], [{ id: "w", wave: 1 }], 1],
    ["a waived spec wave", [{ path: "w1", spec: true, specsSkipped: "docs exist" }], [{ id: "w", wave: 1 }], 1],
    ["a spec wave whose prior is the worker", [{ path: "w1", spec: true }], [{ id: "w", wave: 1 }], 1],
    ["a later wave, replacing the first wave's worker", [{ path: "w1" }, { path: "w2" }], [{ id: "w", wave: 1 }, { id: "t", wave: 2, replaces: "w" }], 2],
  ] as [string, PlanWave[], { id: string; wave: number; kind?: string; replaces?: string }[], number][])("is admitted on %s, replacing the chain owner", (_label, waves, workers, wave) => {
    const owner = workers.at(-1)!.id;
    expect(route(waves, workers, wave, owner)).toMatchObject({ kind: "spec-writer", lane: "implementation" });
  });

  test("a row that is not the chain owner is refused with the owner's call, on a non-spec chain too", () => {
    const waves: PlanWave[] = [{ path: "w1" }, { path: "w2" }];
    const workers = [{ id: "w", wave: 1 }, { id: "t", wave: 2, replaces: "w" }];
    expect(() => route(waves, workers, 2, "w")).toThrow(`A Spec Writer here replaces the chain's current implementation row: chief_delegate (planThreadId: ${P}, wave: 2, replaces: t, kind: spec-writer).`);
    expect(() => world({ [P]: waves }).admit({ ...planned, kind: "spec-writer", resolvedKind: "spec-writer", wave: 1 })).toThrow("no worker has started wave 1's chain yet");
  });

  test("a design-only wave refuses it and names the successor wave's route", () => {
    const waves: PlanWave[] = [{ path: "d", design: true }, { path: "w2" }];
    const rows = [{ id: "d", wave: 1, kind: "designer" }, { id: "w", wave: 2, replaces: "d" }];
    expect(() => route(waves, rows.slice(0, 1), 1, "d")).toThrow(`Wave 1 is design-only: it changes no repository files. Route its docs need to wave 2: put it in that wave's Spec Writer mission when the wave is spec: true, else chief_delegate (planThreadId: ${P}, wave: 2, replaces: d, kind: spec-writer) once its worker has reported.`);
    expect(() => route(waves, rows, 1, "d")).toThrow(`wave: 2, replaces: w, kind: spec-writer) once its worker has reported.`);
    expect(() => world({ [P]: waves }).admit({ ...planned, kind: "spec-writer", resolvedKind: "spec-writer", wave: 1 })).toThrow("replaces: <that wave's chain owner>, kind: spec-writer");
  });

  test("the side lane is unchanged: a first writer on an unwaived spec wave is admitted beside the worker, and a second live one is refused", () => {
    const waves: PlanWave[] = [{ path: "w1", spec: true }];
    expect(world({ [P]: waves }, [{ id: "w", plan: P, wave: 1 }]).admit({ ...planned, kind: "spec-writer", resolvedKind: "spec-writer", branch: CHAIN, wave: 1 })).toMatchObject({ lane: "side" });
    const live = world({ [P]: waves }, [{ id: "w", plan: P, wave: 1 }, { id: "sw", plan: P, wave: 1, kind: "spec-writer", state: "active", last: null }]);
    expect(() => live.admit({ ...planned, kind: "spec-writer", resolvedKind: "spec-writer", branch: CHAIN, wave: 1 })).toThrow("is still live");
  });

  test("a spec waiver waives the planned delta only: waiveSpecs is unchanged and the writer route stays open", () => {
    const { lifecycle } = world({ [P]: [{ path: "w1", spec: true }] }, [{ id: "w", plan: P, wave: 1, state: "active", last: null }]);
    expect(lifecycle.waiveSpecs(P, 1)).toMatchObject({ outcome: "waive" });
    expect(route([{ path: "w1", spec: true, specsSkipped: "docs exist" }], [{ id: "w", wave: 1 }], 1, "w")).toMatchObject({ lane: "implementation" });
  });
});

// Contract (docs/specs/plan-chains.md "Stacked Chain Base"): planBase is the one owner of a chain head's base. Identity (durable): a stackOn head is based on the
// task branch of wave k's chain implementation owner (a side-lane Spec Writer alone does not count), else the planner's recorded branch, else null (project default).
// Readiness (live): a stackOn head waits until wave k's latest implementation worker is ready or complete. Rows are in memory; the wave graph is the real createWaveSchedule.
describe("planBase: identity and readiness of a stacked or branch-based chain", () => {
  const STACK: PlanWave[] = [{ path: "w1" }, { path: "w2" }, { path: "w3", dependsOn: [], stackOn: 1 }, { path: "w4", dependsOn: [3] }];
  const parent = (over: Partial<Worker> = {}): Worker => ({ id: "w1", plan: P, wave: 1, branch: "feature/a", ...over });
  const stacked = (workers: Worker[], plans: PlanWave[] = STACK) => {
    const w = world({ [P]: plans }, workers);
    return { ...w, schedule: createWaveSchedule(() => w.rows) };
  };

  test("a plan with no stackOn and an unbranched planner has the project default: null for every wave", () => {
    const { schedule } = stacked([parent()], [{ path: "w1" }, { path: "w2", dependsOn: [] }, { path: "w3", dependsOn: [2] }]);
    for (const n of [1, 2, 3]) expect(schedule.planBase(P, n), `wave ${n}`).toBeNull();
  });

  test("a planner with a recorded branch fixes every chain head to it, never waiting", () => {
    const { rows, schedule } = stacked([], [{ path: "w1" }, { path: "w2", dependsOn: [] }, { path: "w3", dependsOn: [2] }]);
    rows.get(P)!.branch = "feature/open-pr";
    for (const n of [1, 2, 3]) expect(schedule.planBase(P, n), `wave ${n}`).toEqual({ stacked: true, base: "feature/open-pr" });
  });

  test.each([
    ["no worker yet", [], null, true],
    ["active", [parent({ state: "active", last: null })], "feature/a", true],
    ["blocked", [parent({ state: "blocked", last: "blocked" })], "feature/a", true],
    ["idle after a blocked report", [parent({ state: "idle", last: "blocked" })], "feature/a", true],
    ["idle with no report", [parent({ state: "idle", last: null })], "feature/a", true],
    ["ready", [parent()], "feature/a", false],
    ["idle after a ready report", [parent({ state: "idle", last: "ready" })], "feature/a", false],
    ["complete", [parent({ state: "complete", last: "ready" })], "feature/a", false],
  ] as const)("a stackOn head: wave k's worker %s", (_label, workers, base, waiting) => {
    const { schedule } = stacked([...workers]);
    const pb = schedule.planBase(P, 3)!;
    expect(pb.stacked).toBe(true);
    expect(pb.base).toBe(base);
    expect(pb.waiting !== undefined).toBe(waiting);
    if (waiting) expect(pb.waiting).toBe("wave 3 stacks on wave 1, whose worker has not reported ready yet");
  });

  test("the base is unresolved while only a side-lane Spec Writer of wave k exists, then the implementation owner's branch", () => {
    const SPEC: PlanWave[] = [{ path: "w1", spec: true }, ...STACK.slice(1)];
    const writer: Worker = { id: "sw", plan: P, wave: 1, kind: "spec-writer", branch: "feature/a-docs" };
    expect(stacked([writer], SPEC).schedule.planBase(P, 3)).toMatchObject({ base: null, unresolved: "wave 1's chain has no task branch yet" });
    expect(stacked([writer, parent()], SPEC).schedule.planBase(P, 3)).toMatchObject({ base: "feature/a" });
    const branchless = stacked([parent()], SPEC);
    branchless.rows.get("w1")!.branch = null;
    expect(branchless.schedule.planBase(P, 3)).toMatchObject({ base: null, unresolved: "wave 1's chain has no task branch yet" });
  });

  test("a stackOn head ignores the planner's branch; a later wave of the stacked chain shares its head's base", () => {
    const { rows, schedule } = stacked([parent()]);
    rows.get(P)!.branch = "feature/open-pr";
    expect(schedule.planBase(P, 3)).toEqual({ stacked: true, base: "feature/a" });
    expect(schedule.planBase(P, 4)).toEqual(schedule.planBase(P, 3));
  });

  test("identity does not depend on readiness: when wave k's chain re-enters a fix round, the head waits but its base stays", () => {
    const ready = stacked([parent()]).schedule.planBase(P, 3)!;
    expect(ready.waiting).toBeUndefined();
    const fixing = stacked([parent({ state: "complete" }), { id: "fix", plan: P, wave: 1, replaces: "w1", branch: "feature/a", state: "active", last: null }]).schedule.planBase(P, 3)!;
    expect(fixing.waiting).toBeDefined();
    expect(fixing.base).toBe(ready.base);
  });

  test("undelegatedHeads: a head whose base is waiting or unresolved is listed apart, and joins undelegated once it can launch", () => {
    const heads = (workers: Worker[]) => { const { schedule } = stacked(workers); const { heads, undelegated, waiting } = schedule.undelegatedHeads(P, schedule.planWavesFor(P)); return { heads, undelegated, waiting }; };
    expect(heads([parent({ state: "active", last: null })])).toEqual({ heads: [1, 3], undelegated: [], waiting: [3] });
    expect(stacked([{ id: "sw", plan: P, wave: 1, kind: "spec-writer", branch: "feature/a-docs" }], [{ path: "w1", spec: true }, ...STACK.slice(1)]).schedule.undelegatedHeads(P, STACK)).toMatchObject({ undelegated: [1], waiting: [3] });
    expect(heads([parent()])).toEqual({ heads: [1, 3], undelegated: [3], waiting: [] });
    const unstacked = stacked([parent({ state: "active", last: null })], [{ path: "w1" }, { path: "w2" }, { path: "w3", dependsOn: [] }, { path: "w4", dependsOn: [3] }]);
    expect(unstacked.schedule.undelegatedHeads(P, unstacked.schedule.planWavesFor(P))).toMatchObject({ undelegated: [3], waiting: [] });
  });
});

describe("admitDelegation: a fresh head on a plan base", () => {
  const STACK: PlanWave[] = [{ path: "w1" }, { path: "w2" }, { path: "w3", dependsOn: [], stackOn: 1 }, { path: "w4", dependsOn: [3] }];
  const parentRow = (over: Partial<Worker> = {}): Worker => ({ id: "w1", plan: P, wave: 1, branch: "feature/a", ...over });

  test("is refused while the parent chain is not ready, with a reason that offers no explicit base", () => {
    for (const workers of [[], [parentRow({ state: "active", last: null })]]) {
      const { admit } = world({ [P]: STACK }, workers);
      const refusal = (() => { try { admit({ ...planned, wave: 3, branch: "main" }); } catch (error) { return (error as Error).message; } return ""; })();
      expect(refusal).toMatch(/^Wave 3 is stacked: /);
      expect(refusal).not.toMatch(/\bbase\b/);
    }
  });

  test("is refused without a branch once launchable, and admitted with one carrying the plan base", () => {
    const { admit } = world({ [P]: STACK }, [parentRow()]);
    expect(() => admit({ ...planned, wave: 3 })).toThrow(`Wave 3 stacks on feature/a: run chief_forge_init (planThreadId: ${P}, wave: 3) and pass its branch.`);
    expect(admit({ ...planned, wave: 3, branch: "feature/b" })).toMatchObject({ stackBase: "feature/a", waveIndependent: true });
  });

  test("a head of a branch-based plan is refused without a branch and never falls back to the default base", () => {
    const { rows, admit } = world({ [P]: [{ path: "w1" }, { path: "w2" }] });
    rows.get(P)!.branch = "feature/open-pr";
    expect(() => admit({ ...planned, wave: 1 })).toThrow("Wave 1 stacks on feature/open-pr: run chief_forge_init");
    expect(admit({ ...planned, wave: 1, branch: "feature/b" })).toMatchObject({ stackBase: "feature/open-pr" });
  });

  test("unchanged: an unstacked plan admits a fresh head with no branch, and a continuation or replacement on a stacked chain needs no new branch", () => {
    const unstacked = world({ [P]: [{ path: "w1" }, { path: "w2", dependsOn: [] }] }, [{ id: "w1", plan: P, wave: 1 }]);
    expect(unstacked.admit({ ...planned, wave: 2 })).toMatchObject({ stackBase: undefined, waveIndependent: true });
    const chain = world({ [P]: STACK }, [parentRow(), { id: "w3", plan: P, wave: 3, branch: "feature/b" }]);
    expect(chain.admit({ ...planned, wave: 4, prior: "w3", kind: "worker", resolvedKind: "worker" })).toMatchObject({ stackBase: undefined });
  });
});

// Contract (plan-1 cutover): a plan persisted as [build, {test: true}] before the review gate keeps both waves in its raw JSON. With no row on
// wave 2 it is `absent`: still counted, never pending, never delegable. With a tester row on it, it is an ordinary wave owned by its latest row.
// Regression: the absent wave stays pending (the plan never finishes, chief_review waits on betweenWaves) or a started legacy chain loses its owner.
describe("legacy test wave cutover", () => {
  const legacy: PlanWave[] = [{ path: "w1" }, { path: "w2", test: true }];

  test("with no row on wave 2, the wave is kept and absent, and nothing pends once wave 1 is delegated and ready", () => {
    const { rows } = world({ [P]: legacy }, [{ id: "w", plan: P, wave: 1 }]);
    const schedule = createWaveSchedule(() => rows);
    const waves = schedule.planWavesFor(P);
    expect(waves).toHaveLength(2);
    expect(waves.map((entry) => !!entry.absent)).toEqual([false, true]);
    expect(schedule.pendingWaves(P, waves)).toEqual([]);
  });

  test("with a tester row on wave 2, it is an ordinary wave whose latest row is its owner", () => {
    const { rows, admit } = world({ [P]: legacy }, [{ id: "w", plan: P, wave: 1 }, { id: "t", plan: P, wave: 2, kind: "tester", replaces: "w" }]);
    const schedule = createWaveSchedule(() => rows);
    const waves = schedule.planWavesFor(P);
    expect(waves.map((entry) => !!entry.absent)).toEqual([false, false]);
    expect(schedule.chainOwner(P, waves, 2)?.thread_id).toBe("t");
    expect(admit({ ...planned, wave: 2, prior: "t", kind: "worker", resolvedKind: "worker" })).toMatchObject({ kind: "worker", lane: "implementation" });
  });
});
