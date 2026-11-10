import { CONSULT_AFTER_REJECTIONS, STOP_AFTER_REJECTIONS } from "../../reviewLedger";
import { delegateParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerDelegateTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_delegate",
    presentation: { label: { pending: "Delegating work…", completed: "Delegated work" } },
    description: `Delegate one clearly titled unit of implementation work to a visible worker in its own managed worktree. See kind for Designer work. verifyCommand goes into the worker's brief as its own check. One plan chain has one branch, pull request and worktree: a later wave of a chain needs replaces: the chain's latest worker, replaces: never crosses to another chain, a started chain is not delegated fresh again, and a replacement keeps its prior's prUrl. replaces: is refused after ${CONSULT_AFTER_REJECTIONS} consecutive request_changes on the task until a consult has given its advice (a ready or blocked report), and from ${STOP_AFTER_REJECTIONS} on unless userApprovedRound is set; the count follows the replaces: chain and every reviewer, and only an approve resets it. A plan with more than one wave or marked complex is refused until its one advisor review resolves (chief_consult planThreadId).`,
    parameters: delegateParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) {
        throw new Error("chief_delegate requires an active registered Chief thread.");
      }
      const result = await ctx.delegate(params, context.threadId);
      return `Started worker “${result.title}” in thread ${result.threadId}. Track it with chief_roster.`;
    },
  });}

