import { delegateParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerDelegateTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_delegate",
    presentation: { label: { pending: "Delegating work…", completed: "Delegated work" } },
    description: `Delegate one clearly titled unit of implementation work to a visible worker in its own managed worktree. A plan chain has one branch, pull request and implementation worktree: a later wave needs replaces: the chain's latest worker (never another chain's), a started chain is not delegated fresh, and a replacement keeps its prior's prUrl. Refused for a plan while a plan advisor you started is still running (chief_consult planThreadId). Gate repair, only when the gate needs a fix: replaces: the gate's first target with kind: worker starts its one fix run in that target's worktree (a second is refused); a fix run that stopped before it reported frees its slot: replaces: it with kind: worker. After completion, replaces: a completed gate target or fix run with kind: worker starts a chat fix on the open, unmerged pull request: no review, it completes on its own ready report.`,
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

