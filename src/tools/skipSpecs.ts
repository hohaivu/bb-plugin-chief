import { MAX_WAVES } from "../report/reportIntake";
import { z } from "zod";
import { overrideSchema } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerSkipSpecsTool(ctx: Ctx) {
  const { plans, store, waveWorkers } = ctx;
  ctx.registerChiefTool({
    name: "chief_skip_specs",
    presentation: { label: { pending: "Waiving specs…", completed: "Waived specs" } },
    description: "Go without the Spec Writer of a plan's spec: true implementation wave, by your own judgment, before that wave's first delegation: your reason is recorded on that wave (no Spec Writer can be delegated on it; its worker runs first and the review judges it against its plan) and shown in chief_roster, chief_inspect and the review. It never waives the tests. Refused for a wave that is not a spec: true implementation wave, or once any worker was delegated on it (re-plan with a fresh chief_plan instead). Calling it again changes nothing.",
    parameters: z.object({ planThreadId: z.string(), wave: z.number().int().min(1).max(MAX_WAVES), reason: overrideSchema.describe("Why this wave goes without its Spec Writer.") }),
    async execute({ planThreadId, wave, reason }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      const planner = store.get(planThreadId);
      if (!planner || planner.role !== "planner" || !ctx.controlsThread(planner, caller.thread_id)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      if (!reason) throw new Error("reason is required: why this wave goes without its Spec Writer.");
      ctx.touchCallerChief(caller);
      const refusal = ctx.planReviewRefusal(planner);
      if (refusal) throw new Error(refusal);
      const { outcome, parent } = plans.waiveSpecs(planThreadId, wave);
      const nextStep = `Specs on wave ${wave} bypassed: delegate its worker — chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}${parent !== null ? `, replaces: ${waveWorkers(planThreadId, parent).at(-1)?.thread_id ?? `<wave ${parent}'s latest worker>`}` : ""}, kind: worker)${parent !== null ? ` once wave ${parent} is ready` : ""}.`;
      if (outcome === "already-waived-delegated") return `Specs on wave ${wave} were already bypassed.`;
      if (outcome === "waive") store.skipWave(planThreadId, wave, { specsSkipped: reason });
      return nextStep;
    },
  });}

