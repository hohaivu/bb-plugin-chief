import { z } from "zod";
import type { Ctx } from "../runtime/context";

export function registerInspectTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_inspect",
    presentation: { label: { pending: "Inspecting thread…", completed: "Inspected thread" } },
    description: "Inspect one managed thread's live status, persisted report summary, full-report file path, and bounded last assistant output before deciding what to do.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      const target = await ctx.resolveTarget(threadId, caller.thread_id);
      if (!target || !ctx.belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      ctx.touchCallerChief(caller);
      return ctx.inspect(threadId, caller.project_id);
    },
  });}

