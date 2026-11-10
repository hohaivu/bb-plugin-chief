import { z } from "zod";
import { MAX_NUDGE_LENGTH } from "../runtime/constants";
import type { Ctx } from "../runtime/context";

export function registerContinueTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_continue",
    presentation: { label: { pending: "Nudging thread…", completed: "Nudged thread" } },
    description: `Send a short nudge (at most ${MAX_NUDGE_LENGTH} characters) to a managed thread that is still working. Refused for any thread that has reported (ready or complete); follow-up work goes to a fresh worker, planner, reviewer, advisor or researcher (see the core rules).`,
    parameters: z.object({
      threadId: z.string(),
      instruction: z.string().trim().min(1).max(MAX_NUDGE_LENGTH).describe(`A short nudge, at most ${MAX_NUDGE_LENGTH} characters.`),
    }),
    async execute({ threadId, instruction }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      await ctx.controlledTarget(threadId, caller);
      ctx.touchCallerChief(caller);
      const capped = await ctx.continueThread(threadId, instruction, caller.thread_id);
      return `Continued ${threadId}.${capped ? ctx.stallCapNote : ""}`;
    },
  });}

