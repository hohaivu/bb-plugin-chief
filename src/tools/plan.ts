import { planParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerPlanTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_plan",
    presentation: { label: { pending: "Starting planner…", completed: "Started planner" } },
    description: "Send one unit of work to a read-only planner that proposes an implementation plan split into waves; its ready alert names the exact next call. The brief gives the problem, the owner's decisions and the real constraints, not the planner's own rules. Write a constraint as a role's work (\"a spec: true wave updates docs/<file>\", not \"keep docs/<file> current\"). Cite a line number only in a file the brief names, after reading that line. Settle each decision first, or pass it as an open question with your default answer.",
    parameters: planParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) {
        throw new Error("chief_plan requires an active registered Chief thread.");
      }
      const result = await ctx.startPlan(params, context.threadId);
      return `Started planner “${result.title}” in thread ${result.threadId}. Its ready alert lists the wave schedule and the exact next call.${result.warning ? `\n${result.warning}` : ""}`;
    },
  });}

