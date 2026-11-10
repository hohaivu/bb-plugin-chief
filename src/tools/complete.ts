import { clip } from "../core/text";
import { z } from "zod";
import { MAX_RESULT_LENGTH } from "../runtime/constants";
import { overrideSchema, type TodoRow } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerCompleteTool(ctx: Ctx) {
  const { store, todosForProject } = ctx;
  ctx.registerChiefTool({
    name: "chief_complete",
    presentation: { label: { pending: "Completing work…", completed: "Completed work" } },
    description: "Mark an idle managed worker or reviewer complete after Chief has inspected sufficient evidence. Completing a worker also completes its reviewers and the advisors consulted on it, and — after the plan's final wave — its planner. A worker completed with an approving review (or a design wave with the owner's approval) while the cleanupApproved setting is on is then cleaned up by a background cleanup worker: it archives the task's threads when nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there; override and skipReview completions are never cleaned up. A design-only wave's worker completes only with the owner's approval recorded by chief_owner_approval. Any other worker with a pull request completes only when the newest review is an approve for the pull request's current head commit (a worker without one: for its current report); otherwise it is refused naming the reason. override (a reason) is the only bypass and is recorded in the result. skipReview (your reason) completes a worker without any review when you judge one unnecessary. A Spec Writer is never completed on any path (override and skipReview included), except on a test wave chief_skip_tests waived: its worker (or a tester rerun) follows it. After a worker completes, this call marks its draft pull request ready for review: never run gh pr ready or glab mr update --ready yourself for a worker's pull request.",
    parameters: z.object({ threadId: z.string(), result: z.string().trim().max(MAX_RESULT_LENGTH).optional(), override: overrideSchema.describe("Complete a worker even though no approve covers its pull request head (or current report). The reason is recorded in its result. Use only when the user or the evidence justifies skipping the review."),
      skipReview: overrideSchema.describe("Complete a worker without a review, by your own judgment: your reason, shown in chief_roster, chief_inspect and on the pull request. Refused only while a review of the task is running, without a ready report, on a design wave (needs chief_owner_approval), or together with override. Refused, like override, for a Spec Writer. Never cleaned up."),
      testsSkipped: overrideSchema.describe("Your reason for completing unplanned work with no tester: an unplanned worker whose task chain has no tester is refused without it. Shown in chief_roster, chief_inspect and on the pull request. A plan's test wave is waived with chief_skip_tests instead.") }),
    async execute({ threadId, result, override, skipReview, testsSkipped }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      await ctx.controlledTarget(threadId, caller);
      ctx.touchCallerChief(caller);
      const { row, overridden, skipped, cleanup } = await ctx.markComplete(threadId, result, override, skipReview, testsSkipped);
      const ready = await ctx.readyPullRequest(row);
      const todos = row.role === "worker" ? (todosForProject.all(caller.project_id) as TodoRow[]).filter((todo) => todo.chief_thread_id === caller.thread_id) : [];
      const todoLine = todos.length
        ? `\n${clip(`Open todos: ${todos.map((todo) => `#${todo.id} ${clip(todo.text, 80)}`).join(", ")} — close any this work finished with chief_roster todo { id, state: "done" }.`, 1_000)}`
        : "";
      return `Marked “${row.title}” complete${overridden ? ` without a matching approve (override recorded in its result)` : skipped ? " without a review (reason recorded)" : ""}.${ready.line}${ctx.cleanupLine(cleanup)}${todoLine}`;
    },
  });}

