import { clip } from "../core/text";
import { z } from "zod";
import { type TodoRow } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerRosterTool(ctx: Ctx) {
  const { closedTodosForProject, db, insertTodo, store, todoById, updateTodo } = ctx;
  ctx.registerChiefTool({
    name: "chief_roster",
    presentation: { label: { pending: "Reading roster…", completed: "Read roster" } },
    description: "Inspect this project's managed threads and their bounded persisted status, result, blocker, and recommendation. Opens with a Pending block naming each item's next action, in the same wording as its lifecycle alert. Add a todo with `todo.text` (and optional `after`, e.g. 'PR #42 merges'); change one by `todo.id`; close it with `state: done|dropped`. Track all Chief work here — including queued work nobody has delegated yet. Todos with an after: condition are summarised as one line; pass includeWaiting: true to list them. Each todo belongs to the Chief that added it; others' todos show as one count line (includeOthers: true lists them, tagged) — leave them unless the user asks.",
    parameters: z.object({
      includeComplete: z.boolean().optional(),
      includeWaiting: z.boolean().optional().describe("List todos that wait on an after: condition in full; by default the Pending block shows them as one count line."),
      includeOthers: z.boolean().optional().describe("List todos owned by other or ended Chiefs, and unowned ones, in full; by default the Pending block shows them as one count line."),
      todo: z.object({
        id: z.number().int().optional(),
        text: z.string().trim().min(1).max(500).optional(),
        after: z.string().trim().max(200).optional().describe("Empty string clears it."),
        state: z.enum(["open", "done", "dropped"]).optional(),
      }).optional(),
    }),
    async execute({ includeComplete, includeWaiting, includeOthers, todo }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error("chief_roster requires an active registered Chief thread.");
      ctx.touchCallerChief(caller);
      let note = "";
      if (todo) {
        const now = Date.now();
        if (todo.id === undefined) {
          if (!todo.text) throw new Error("chief_roster todo needs text to add, or an id to change.");
          insertTodo.run(caller.project_id, caller.thread_id, todo.text, todo.after || null, now, now);
        } else {
          const existing = todoById.get(todo.id, caller.project_id) as TodoRow | undefined;
          if (!existing) throw new Error(`No todo #${todo.id} in this project.`);
          const after = todo.after === undefined ? existing.after : todo.after || null;
          updateTodo.run(todo.text ?? existing.text, after, todo.state ?? existing.state, now, todo.id, caller.project_id);
          if (existing.chief_thread_id && existing.chief_thread_id !== caller.thread_id && ctx.isActiveChief(store.get(existing.chief_thread_id))) {
            note = `Note: todo #${existing.id} belongs to Chief ${existing.chief_thread_id}; change it only when the user asks.\n`;
          }
        }
        store.reload();
      }
      if (ctx.isCoordinator(caller)) {
        const children = store.all().filter((row) => row.role === "chief" && row.coordinator_thread_id === caller.thread_id);
        const live = children.filter((row) => !ctx.INACTIVE_CHIEF_STATES.includes(row.state));
        const share = Math.floor(4_000 / Math.max(live.length, 1));
        // An idle child with a Need you from this turn is waiting for the owner, not for work.
        const needsOwner = (child: typeof children[number]) => {
          if (child.state !== "idle") return "";
          const asked = db.prepare(`SELECT MAX(created_at) AS at FROM alert_outbox WHERE dedupe_key LIKE ?`).get(`${child.thread_id}:coordinator-need-you:%:${child.active_cycle}`) as { at: number | null };
          return asked.at === null ? "" : ` · needs the owner since ${new Date(asked.at).toISOString()}`;
        };
        return clip([
          ...(live.length ? ["## Children", ...live.map((child) => clip(`- “${clip(child.title, 120)}” (${child.thread_id}) · project ${child.project_id} · ${child.state}${needsOwner(child)}\n${ctx.pendingBlock(child.thread_id, includeWaiting, share, includeOthers).replace(/\n/g, "\n  ")}`, share))] : []),
          ...(children.length > live.length ? [`closed: ${children.length - live.length}`] : []),
          ...(live.length ? [] : ["No child Chiefs. Attach ones the owner names with chief_attach, or start one with chief_spawn."]),
          note + ctx.pendingBlock(caller.thread_id, includeWaiting, 1_500, includeOthers),
        ].join("\n"), 6_000);
      }
      const rows = ctx.rosterForChief(caller.thread_id, includeComplete);
      const reversed = [...rows].reverse();
      // The Pending block is clipped on its own so it always survives whole (or
      // ends with "…and N more pending"), then the rest gets whatever budget is
      // left — otherwise one clip() across both could cut a pending action off mid-line.
      const pending = note + ctx.pendingBlock(caller.thread_id, includeWaiting, 6_000 - note.length, includeOthers);
      const room = 6_000 - pending.length - 1;
      // clip() with a limit of 0 or less returns the whole string, so a full Pending block drops the rest.
      if (room <= 0) return pending;
      const rest = clip([
        ...reversed.map((row) => ctx.rosterRowLines(row).join("\n  ")),
        ...(includeComplete ? (closedTodosForProject.all(caller.project_id) as TodoRow[]).map((todo) => ctx.todoLine(todo, caller.thread_id)) : []),
      ].join("\n"), room);
      return `${pending}\n${rest}`;
    },
  });}

