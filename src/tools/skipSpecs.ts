import { z } from "zod";
import { overrideSchema } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerSkipSpecsTool(ctx: Ctx) {
  const { plans, store } = ctx;
  ctx.registerChiefTool({
    name: "chief_skip_specs",
    presentation: { label: { pending: "Waiving specs…", completed: "Waived specs" } },
    description: "Go without the plan's one Spec Writer, by your own judgment, until it was delegated. Your reason is recorded on every spec: true wave and shown in chief_roster, chief_inspect and the review; no Spec Writer can be delegated on those waves afterwards, and the review judges the work against its plan. Refused for a plan with no spec: true implementation wave, or once its Spec Writer was delegated (fix its docs with chief_delegate (replaces: the writer, kind: spec-writer), or re-plan with a fresh chief_plan). A repeat call changes nothing.",
    parameters: z.object({ planThreadId: z.string(), reason: overrideSchema.describe("Why this plan goes without its Spec Writer.") }),
    async execute({ planThreadId, reason }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      const planner = store.get(planThreadId);
      if (!planner || planner.role !== "planner" || !ctx.controlsThread(planner, caller.thread_id)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      if (!reason) throw new Error("reason is required: why this plan goes without its Spec Writer.");
      ctx.touchCallerChief(caller);
      const refusal = ctx.planReviewRefusal(planner);
      if (refusal) throw new Error(refusal);
      const { outcome, waves } = plans.waiveSpecs(planThreadId);
      if (outcome === "already-waived") return `Specs on planner ${planThreadId} were already bypassed.`;
      store.batch(() => { for (const n of waves) store.skipWave(planThreadId, n, { specsSkipped: reason }); });
      ctx.observe.event("specs_skipped", { ...planner, plan_thread_id: planThreadId, plan_wave: null }, reason);
      return `Specs bypassed for planner ${planThreadId} (wave(s) ${waves.join(", ")}): no Spec Writer runs for this plan; start the review gate when the ready alert names it.`;
    },
  });}

