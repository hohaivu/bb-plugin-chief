import { z } from "zod";
import type { Ctx } from "../runtime/context";

export function registerOwnerApprovalTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_owner_approval",
    presentation: { label: { pending: "Recording approval…", completed: "Recorded approval" } },
    description: "Record the owner's approval of a design-only wave (a plan wave marked design: true). Only the owner approves design-only work; chief_review refuses it. Show the user the artboards from the designer's ready report, ask for explicit approval, then call this with their words verbatim. The wave that implements the artboards cannot be delegated, and the design wave cannot be completed, without it. A new report or chief_continue on the designer clears it. Refused for any other thread.",
    parameters: z.object({
      workerThreadId: z.string(),
      approval: z.string().trim().min(1).max(2_000).describe("The user's own words approving the artboards, verbatim."),
    }),
    async execute({ workerThreadId, approval }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed worker ${workerThreadId} for this Chief.`);
      const target = await ctx.controlledTarget(workerThreadId, caller);
      ctx.touchCallerChief(caller);
      return ctx.recordOwnerApproval(target, approval);
    },
  });}

