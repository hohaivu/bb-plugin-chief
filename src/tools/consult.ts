import { consultParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerConsultTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_consult",
    presentation: { label: { pending: "Starting advisor…", completed: "Started advisor" } },
    description: "Start a read-only advisor on a hard problem or a change that keeps failing review. It may read code and run commands to reproduce it, never edits, and reports its advice back to you. With planThreadId, it gives a multi-wave or complex plan its one review before delegation; refused for any other plan.",
    parameters: consultParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) {
        throw new Error("chief_consult requires an active registered Chief thread.");
      }
      if (params.workerThreadId) {
        await ctx.controlledTarget(params.workerThreadId, caller);
      }
      ctx.touchCallerChief(caller);
      const result = await ctx.startConsult(params, context.threadId);
      return `Started advisor “${result.title}” in thread ${result.threadId}. Wait for its advice before starting another worker round.`;
    },
  });}

