import { z } from "zod";
import type { Ctx } from "../runtime/context";

export function registerAttachTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_attach",
    presentation: { label: { pending: "Attaching Chiefs…", completed: "Attached Chiefs" } },
    description: "Coordinator only: link existing Chief threads as your children, in any project. Give the thread ids the owner names (1-20). One result line per id; a bad id never blocks the others. An id that is not a Chief row needs `bb chief adopt --thread <id>` first.",
    parameters: z.object({ threadIds: z.array(z.string().trim().min(1)).min(1).max(20) }),
    async execute({ threadIds }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isCoordinator(caller) || !ctx.isActiveChief(caller)) throw new Error("chief_attach is for a Coordinator only: run /coordinator first (a child Chief cannot become one).");
      const own = "is already your child";
      const lines = [...new Set(threadIds)].map((id) => {
        const refusal = () => {
          const row = store.get(id);
          if (id === caller.thread_id) return "is you";
          if (!row || row.role !== "chief") return `is not a Chief row: run \`bb chief adopt --thread ${id}\` first`;
          if (ctx.INACTIVE_CHIEF_STATES.includes(row.state)) return `is ${row.state}`;
          if (ctx.isCoordinator(row)) return "is a Coordinator";
          if (row.coordinator_thread_id === caller.thread_id) return own;
          if (row.coordinator_thread_id) return `already belongs to Coordinator ${row.coordinator_thread_id}`;
          return null;
        };
        // The conditional link write settles a race: when it changes no row, the row is read again for the reason.
        const why = refusal() ?? (store.linkToCoordinator(id, caller.thread_id, Date.now()) ? null : refusal() ?? "its state changed; try again");
        // A Chief that is already idle and done alerts through the sweep the link write starts.
        return why === null ? `${id}: attached.` : why === own ? `${id}: already attached (no change).` : `${id}: not attached: ${why}.`;
      });
      return lines.join("\n");
    },
  });}

