import { z } from "zod";
import type { Ctx } from "../runtime/context";

const reviewParams = z.object({
  workerThreadId: z.string().trim().min(1).optional().describe("An existing managed worker's thread id."),
  pullRequest: z.string().trim().min(1).max(500).optional().describe(
    "A pull request to review when no managed worker owns it: a number, an owner/repo#123 reference, or a PR URL. Resolved to its head branch with gh or glab, falling back to the raw value as a branch name.",
  ),
  branch: z.string().trim().min(1).max(300).optional().describe("A branch to review when no managed worker owns it."),
  focus: z.string().trim().max(4_000).optional(),
}).refine((value) => [value.workerThreadId, value.pullRequest, value.branch].filter((v) => v !== undefined).length === 1, {
  message: "Give exactly one of workerThreadId, pullRequest, or branch.",
});

export function registerReviewTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_review",
    presentation: { label: { pending: "Starting review…", completed: "Started review" } },
    description: "Only the active Chief starts reviews; the server refuses every other caller. Start or return an independent read-only review: for a worker with no plan link, in its existing worktree; for a plan worker, ONE review of the whole plan covering the latest worker of every branch, each pull request pinned to its own head commit. It is refused for an intermediate wave, a superseded worker, a design wave, and while any wave of the plan is not ready. With no worker, it reviews a pull request or branch in a fresh worktree; a branch a managed worker carries is refused (review that worker).",
    parameters: reviewParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      ctx.requireChiefCaller(caller, "chief_review");
      if (params.workerThreadId) {
        await ctx.controlledTarget(params.workerThreadId, caller);
        ctx.touchCallerChief(caller);
        return (await ctx.startReview(caller, params.workerThreadId, params.focus)).reply;
      }
      ctx.touchCallerChief(caller);
      return (await ctx.startBranchReview(caller, { branch: params.branch, pullRequest: params.pullRequest }, params.focus)).reply;
    },
  });}

