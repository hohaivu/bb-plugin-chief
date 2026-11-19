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
    description: "Mark an idle managed worker or reviewer complete. A worker's completion also completes its reviewers, its consulted advisors and, after the plan's final wave, its planner; completing a gate's last target also completes its idle reviewer and fix run. With cleanupApproved on, a worker whose review gate passed (or a design wave with the owner's approval) is then cleaned up by a background cleanup worker: it archives the task's threads when nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there. override and skipReview completions are never cleaned up. A design-only wave's worker completes only with the owner's approval recorded by chief_owner_approval. Any other worker, and a review gate's reviewer, completes only when its review gate passed (no blocking code findings or a ready fix run, docs findings repaired); otherwise it is refused naming the gate's state and its next call: chief_complete (threadId: ...) once it passes. A chat fix run completes on its ready report with a clean docs/ history, without a review. override completes without the gate, skipReview with no gate at all. A side-lane Spec Writer (a plan's spec wave) completes like a worker: on a gate pass, skipReview or override; an implementation-lane Spec Writer (unplanned or legacy) completes on no path (override and skipReview included): its worker follows it. After a worker completes, this call marks its draft pull request ready for review.",
    parameters: z.object({ threadId: z.string(), result: z.string().trim().max(MAX_RESULT_LENGTH).optional(), override: overrideSchema.describe("Reason for completing a worker even though no approve covers its pull request head (or current report); recorded in its result."),
      skipReview: overrideSchema.describe("Your reason for completing a worker without a review (your judgment); shown in chief_roster, chief_inspect and on the pull request. Refused only while a review of the task is running, without a ready report, on a design wave (needs chief_owner_approval), together with override, for an implementation-lane Spec Writer, or when the branch has a docs/ commit that no Spec Writer of this task is recorded on (Chief-Spec-Writer trailer); when that check cannot run, the reply says so.") }),
    async execute({ threadId, result, override, skipReview }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      await ctx.controlledTarget(threadId, caller);
      ctx.touchCallerChief(caller);
      const { row, overridden, skipped, cleanup, docsNote } = await ctx.markComplete(threadId, result, override, skipReview);
      const ready = await ctx.readyPullRequest(row);
      const todos = row.role === "worker" ? (todosForProject.all(caller.project_id) as TodoRow[]).filter((todo) => todo.chief_thread_id === caller.thread_id) : [];
      const todoLine = todos.length
        ? `\n${clip(`Open todos: ${todos.map((todo) => `#${todo.id} ${clip(todo.text, 80)}`).join(", ")} — close any this work finished with chief_roster todo { id, state: "done" }.`, 1_000)}`
        : "";
      return `Marked “${row.title}” complete${overridden ? ` without a matching approve (override recorded in its result)` : skipped ? " without a review (reason recorded)" : ""}.${ready.line}${ctx.cleanupLine(cleanup)}${docsNote ? `\n${docsNote}` : ""}${todoLine}`;
    },
  });}

