import { terminal } from "../types";
import { z } from "zod";
import type { Ctx } from "../runtime/context";

export function registerCoordinateTool(ctx: Ctx) {
  const { bb, store } = ctx;
  ctx.registerChiefTool({
    name: "chief_coordinate",
    presentation: { label: { pending: "Becoming Coordinator…", completed: "Became Coordinator" } },
    description: "Upgrade this Chief to a Coordinator, once and for good: it then supervises child Chiefs in any project and runs no managed threads. Refused while this Chief owns an open managed thread, or if it is a child Chief. Call it only when the owner asks for /coordinator.",
    parameters: z.object({
      goal: z.string().trim().min(1).max(4000).optional().describe("The owner's words asking for coordination, verbatim; saved to brief.md."),
    }),
    async execute({ goal }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error("chief_coordinate requires an active registered Chief thread.");
      if (ctx.isCoordinator(caller)) return "Already a Coordinator.";
      if (ctx.isLinkedChild(caller)) throw new Error(`This Chief is a child of Coordinator ${caller.coordinator_thread_id}: a child cannot become a Coordinator.`);
      const title = caller.title.replace(/^Chief(?= ·)/, "Coordinator");
      if (!store.setCoordinator(caller.thread_id, Date.now(), title)) {
        const open = store.all().filter((row) => row.chief_thread_id === caller.thread_id && !terminal(row.state)).map((row) => row.thread_id);
        throw new Error(open.length
          ? `This Chief still owns open managed threads: ${open.join(", ")}. Finish them (complete or stop and complete) before upgrading.`
          : "This Chief cannot become a Coordinator now; read chief_roster and try again.");
      }
      // The upgrade stands even if the rename fails: the row already holds the new title.
      if (title !== caller.title) await bb.sdk.threads.update({ threadId: caller.thread_id, title }).catch((error) => bb.log.warn(`Coordinator title rename failed for ${caller.thread_id}: ${String(error)}`));
      let saved = "";
      if (goal) {
        try {
          await ctx.writeStorageFile(caller.thread_id, "brief.md", `## Coordinator brief\n\n### Owner's request (verbatim)\n${goal}`);
        } catch (error) {
          saved = ` brief.md not saved (${String(error)}).`;
        }
      }
      return "This Chief is now a Coordinator. The upgrade is one-way. It runs no managed threads: it supervises child Chiefs in any project. Attach existing Chiefs the owner names with chief_attach, start new work in a child with chief_spawn (projectId names its project), and read chief_roster for the Children block. A child's Need you and its done state arrive here as alerts; the owner answers in the child thread." + saved;
    },
  });}

