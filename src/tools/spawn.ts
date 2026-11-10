import { z } from "zod";
import { titled, type TodoRow } from "./shapes";
import type { Ctx } from "../runtime/context";

// Oversize input is refused, never clipped. With a todo attached, `\n\nTodo #<id>: <text>` (text <= 500) is
// appended to context, so the handoff's context is at most 12_000 + that prefix + 500 characters.
const spawnParams = z.object({
  title: z.string().trim().min(1).max(160).optional().describe("A literal task label, used in the new Chief's thread title. Optional: defaults to the first line of request, clipped to 160 characters."),
  request: z.string().trim().min(1).max(4_000).describe("The owner's words asking for this task, verbatim."),
  context: z.string().trim().min(1).max(12_000).describe("Goal and success criteria, evidence, linked threads/issues/PRs/branches, plan and verdict file paths, and open decisions."),
  todoId: z.number().int().optional().describe("Your own open todo to move to the new Chief."),
  projectId: z.string().trim().min(1).optional().describe("Coordinator only: the project the new Chief works in. Defaults to your own project."),
}).transform(titled((v) => v.request));

export function registerSpawnTool(ctx: Ctx) {
  const { bb, db, store, todoById } = ctx;
  ctx.registerChiefTool({
    name: "chief_spawn",
    presentation: { label: { pending: "Starting new Chief…", completed: "Started new Chief" } },
    description: "Hand one task to a new Chief for this project when the user asks to do it in a new Chief. Pass a literal title, the user's request verbatim, and the context it needs (goal, evidence, linked threads, issues, PRs, branches, plan and verdict files, open decisions). todoId moves your own open todo to it. It never takes over your managed threads: hand over only a task with no unfinished worker — every worker on it complete (chief_stop and a ready report do not release a worker's branch); otherwise keep the task.",
    parameters: spawnParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) {
        throw new Error("chief_spawn requires an active registered Chief thread.");
      }
      // Validated before spawning, so a refused todo, project or caller leaves no thread and no row.
      const coordinator = ctx.isCoordinator(caller);
      if (params.projectId !== undefined && !coordinator) throw new Error("projectId is for a Coordinator only: a Chief starts new Chiefs in its own project.");
      const target = params.projectId ?? caller.project_id;
      if (params.projectId !== undefined) await bb.sdk.projects.get({ projectId: target }).catch(() => { throw new Error(`No project ${target}.`); });
      if (params.todoId !== undefined && target !== caller.project_id) throw new Error("todoId is for a Chief in your own project: todos belong to one project.");
      const todo = params.todoId === undefined ? undefined : todoById.get(params.todoId, caller.project_id) as TodoRow | undefined;
      if (params.todoId !== undefined && (!todo || todo.state !== "open" || todo.chief_thread_id !== caller.thread_id)) {
        throw new Error(`Todo #${params.todoId} is not one of your open todos; only your own open todo can move to a new Chief.`);
      }
      const handoff = {
        fromChiefThreadId: caller.thread_id,
        title: params.title,
        request: params.request,
        context: todo ? `${params.context}\n\nTodo #${todo.id}: ${todo.text}` : params.context,
        coordinatorThreadId: coordinator ? caller.thread_id : undefined,
      };
      const { threadId } = await ctx.createChief(target, handoff);
      const lines = [coordinator
        ? `Started Chief “${params.title}” in thread ${threadId}, project ${target}. It is linked as your child: it shows in your Children block and alerts you when it needs the owner or finishes. The owner answers it in its own thread.`
        : `Started Chief “${params.title}” in thread ${threadId}. It owns this task now and is not your managed work: it is not in your roster, sends you no alerts, and you cannot inspect or steer it.`];
      if (todo) {
        // Check-and-set: the todo may have changed owner or state while the Chief was starting.
        const moved = db.prepare(`UPDATE chief_todos SET chief_thread_id=?, updated_at=? WHERE id=? AND project_id=? AND chief_thread_id=? AND state='open'`)
          .run(threadId, Date.now(), todo.id, caller.project_id, caller.thread_id).changes;
        store.reload();
        lines.push(moved ? `Todo #${todo.id} moved to it.` : `Todo #${todo.id} was not moved because it changed in the meantime.`);
      }
      // Not persistBrief: its failure only reaches the log, and this one must show in the calling Chief's turn.
      let error: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        try {
          await ctx.writeStorageFile(threadId, "brief.md", ctx.handoffSection(handoff));
          error = undefined;
          break;
        } catch (caught) { error = caught; }
      }
      if (error !== undefined) lines.push(`brief.md not saved (${String(error)}); the handoff is only in its first message.`);
      return lines.join("\n");
    },
  });}

