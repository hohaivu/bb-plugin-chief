import { z } from "zod";
import type { Ctx } from "../runtime/context";

const reviewParams = z.object({
  workerThreadId: z.string().trim().min(1).optional().describe("An existing managed worker's thread id."),
  pullRequest: z.string().trim().min(1).max(500).optional().describe(
    "A pull request to review when no managed worker owns it: a number, an owner/repo#123 reference, or a PR URL. Resolved to its head branch with gh or glab, falling back to the raw value as a branch name.",
  ),
  branch: z.string().trim().min(1).max(300).optional().describe("A branch to review when no managed worker owns it."),
  focus: z.string().trim().max(4_000).optional().describe("What the reviewer should check. Never ask the reviewer to judge whether a verification gap blocks: decide it before the review. Pass a gap you accept in acceptedGaps; otherwise get the evidence first (for example a tester rerun)."),
  acceptedGaps: z.string().trim().min(1).max(1_000).optional().describe("Verification gaps you accepted before this review, with your reason: the reviewer lists them under Manual Verification and never rejects on them alone."),
}).refine((value) => [value.workerThreadId, value.pullRequest, value.branch].filter((v) => v !== undefined).length === 1, {
  message: "Give exactly one of workerThreadId, pullRequest, or branch.",
});

export function registerReviewTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_review",
    presentation: { label: { pending: "Starting review…", completed: "Started review" } },
    description: "Only the active Chief starts reviews; the server refuses every other caller. Opens the review gate of a worker's plan (or unplanned task): it pins every target branch's head (the pull request head, else origin's branch tip) and starts one read-only reviewer and one tester in parallel, each in a fresh worktree. It is refused for an intermediate wave, a superseded worker, a design wave, while any wave of the plan or its Spec Writer is not ready, and while a builder's checkout has uncommitted or unpushed work. After a green fix run on a review that asked for changes, one more call starts one advisory re-review (at most one per gate; the green run passes the gate). Every side launch on an existing gate re-pins each target to its current head. A second call starts only a missing, failed or blocked side; with both live and no advisory re-review due, it starts nothing (while the advisory re-review runs, nothing). With no worker, it reviews a pull request or branch in a fresh worktree; a branch a managed worker carries is refused (review that worker).",
    parameters: reviewParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      ctx.requireChiefCaller(caller, "chief_review");
      if (params.workerThreadId) {
        await ctx.controlledTarget(params.workerThreadId, caller);
        ctx.touchCallerChief(caller);
        return (await ctx.startReview(caller, params.workerThreadId, params.focus, params.acceptedGaps)).reply;
      }
      ctx.touchCallerChief(caller);
      return (await ctx.startBranchReview(caller, { branch: params.branch, pullRequest: params.pullRequest }, params.focus, params.acceptedGaps)).reply;
    },
  });}

