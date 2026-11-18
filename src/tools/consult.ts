import { consultParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerConsultTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_consult",
    presentation: { label: { pending: "Starting advisor…", completed: "Started advisor" } },
    description: "Plans only, optional: start a read-only advisor for one review of a plan (planThreadId) when you choose. Forge init and delegation wait while it runs. It may read code and run commands, never edits, and reports its advice back to you.",
    parameters: consultParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) {
        throw new Error("chief_consult requires an active registered Chief thread.");
      }
      ctx.touchCallerChief(caller);
      const result = await ctx.startConsult(params, context.threadId);
      return `Started advisor “${result.title}” in thread ${result.threadId}. Wait for its advice before delegating the plan.`;
    },
  });}

