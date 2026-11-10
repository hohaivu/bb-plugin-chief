import { MAX_WAVES } from "../report/reportIntake";
import { z } from "zod";
import { overrideSchema } from "./shapes";
import { BUSY_STATUSES } from "../runtime/constants";
import type { Ctx } from "../runtime/context";

export function registerSkipTestsTool(ctx: Ctx) {
  const { bb, latestWorker, plans, store } = ctx;
  ctx.registerChiefTool({
    name: "chief_skip_tests",
    presentation: { label: { pending: "Waiving tests…", completed: "Waived tests" } },
    description: "Go without a plan's test wave (test: true), by your own judgment: your reason is recorded on that wave and shown in chief_roster and chief_inspect. Before the wave is delegated, the wave drops out of the plan and its parent's worker ends the chain. After a tester ran on it, that tester stays the branch owner and you review or complete it (a blocked report counts). Refused while the wave's latest worker is running, once it is complete, or for a wave that is not a test wave. Calling it again changes nothing.",
    parameters: z.object({ planThreadId: z.string(), wave: z.number().int().min(1).max(MAX_WAVES), reason: overrideSchema.describe("Why this plan goes without that wave's tests.") }),
    async execute({ planThreadId, wave, reason }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      const planner = store.get(planThreadId);
      if (!planner || planner.role !== "planner" || !ctx.controlsThread(planner, caller.thread_id)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      if (!reason) throw new Error("reason is required: why this plan goes without that wave's tests.");
      ctx.touchCallerChief(caller);
      const refusal = ctx.planReviewRefusal(planner);
      if (refusal) throw new Error(refusal);
      const { latest, alreadyWaived, parent } = plans.waiveTests(planThreadId, wave);
      if (latest) {
        const live = await bb.sdk.threads.get({ threadId: latest.thread_id });
        if (BUSY_STATUSES.has(live.status)) throw new Error(`Wave ${wave}'s worker ${latest.thread_id} is ${live.status}: wait until it is idle, then waive.`);
      }
      if (!alreadyWaived) store.skipWave(planThreadId, wave, { testsSkipped: reason });
      if (latest) return ctx.waivedLine(latest);
      const owner = parent !== null ? latestWorker(planThreadId, parent) : undefined;
      const next = owner?.state === "ready" ? ctx.workerReadyNextStep(owner, true) : null;
      return next ?? `Wave ${parent} has not reported ready yet; its ready alert names the next call.`;
    },
  });}

