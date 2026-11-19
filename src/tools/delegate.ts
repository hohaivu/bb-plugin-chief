import { delegateParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerDelegateTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_delegate",
    presentation: { label: { pending: "Delegating work…", completed: "Delegated work" } },
    description: `Delegate one clearly titled unit of implementation work to a visible worker in its own managed worktree. See kind for Designer work. verifyCommand goes into the worker's brief as its own check. One plan chain has one branch, pull request and implementation worktree; a plan's one Spec Writer is a fresh delegation (kind: spec-writer) on the plan's last spec: true wave, in its own side worktree, once every wave is ready. A later wave of a chain needs replaces: the chain's latest worker, replaces: never crosses to another chain, a started chain is not delegated fresh again, and a replacement keeps its prior's prUrl. A plan is refused while a plan advisor you started is still running (chief_consult planThreadId). A gate has one fix run (replaces: its tester, kind: worker) and one corrector (replaces: the fix run, kind: tester); a second is refused. A fix run or corrector that stopped before it reported frees its slot: replaces: it with the same kind (worker for a fix run, tester for a corrector). After completion, replaces: a completed gate target or fix run with kind: worker starts a chat fix.`,
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

