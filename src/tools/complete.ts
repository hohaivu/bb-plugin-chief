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
    description: "Mark an idle managed worker or reviewer complete. Completing a worker also completes its reviewers and the advisors consulted on it, and — after the plan's final wave — its planner. A worker whose review gate passed (or a design wave with the owner's approval) while the cleanupApproved setting is on is then cleaned up by a background cleanup worker: it archives the task's threads when nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there; override and skipReview completions are never cleaned up. A design-only wave's worker completes only with the owner's approval recorded by chief_owner_approval. Any other worker, and a review gate's reviewer, completes only when its review gate passed (no blocking code findings or a ready fix run, docs findings repaired); otherwise it is refused naming the gate's state and its next call: chief_complete (threadId: ...) once it passes. Completing the gate's last target also completes its idle reviewer and fix run. A chat fix run completes on its ready report with a clean docs/ history, without a review. override (a reason) completes without the gate and is recorded in the result. skipReview completes a worker with no gate at all. A side-lane Spec Writer (a plan's spec wave) completes like a worker: on a gate pass, skipReview or override. An implementation-lane Spec Writer (unplanned or legacy) completes on no path (override and skipReview included): its worker follows it. After a worker completes, this call marks its draft pull request ready for review.",
    parameters: z.object({ threadId: z.string(), result: z.string().trim().max(MAX_RESULT_LENGTH).optional(), override: overrideSchema.describe("Complete a worker even though no approve covers its pull request head (or current report). The reason is recorded in its result."),
      skipReview: overrideSchema.describe("Complete a worker without a review, by your own judgment: your reason, shown in chief_roster, chief_inspect and on the pull request. Refused only while a review of the task is running, without a ready report, on a design wave (needs chief_owner_approval), or together with override. Refused, like override, for an implementation-lane Spec Writer. Also refused when the branch has a docs/ commit that no Spec Writer of this task is recorded on (Chief-Spec-Writer trailer); when that check cannot run, the reply says so. Never cleaned up.") }),
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

