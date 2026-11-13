import { type ManagedRow } from "../types";
import { z } from "zod";
import { COORDINATOR_REFUSED, coordinatorRefusal } from "../runtime/prompts";
import type { Ctx } from "../runtime/context";

export function createToolRegistry(ctx: Ctx) {
  const { bb, store } = ctx;
  /** bb.agents.registerTool, except that a tool in COORDINATOR_REFUSED refuses a Coordinator caller before it reads any input.
   * A failed call is also ledgered (tool name and first message line only); that observing never replaces the tool's own error. */
  const registerChiefTool = <Schema extends z.ZodType>(tool: Parameters<typeof bb.agents.registerTool<Schema>>[0]) =>
    bb.agents.registerTool({
      ...tool,
      execute: async (params, context) => {
        try {
          if (COORDINATOR_REFUSED.has(tool.name) && ctx.isCoordinator(context.threadId ? store.get(context.threadId) : undefined)) throw new Error(coordinatorRefusal(tool.name));
          return await tool.execute(params, context);
        } catch (error) {
          try {
            const row = (context.threadId ? store.get(context.threadId) : undefined) ?? { thread_id: context.threadId, project_id: context.projectId };
            ctx.observe.event("tool_error", row, `${tool.name}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`, { tool: tool.name });
          } catch { /* observing must never replace the tool's error */ }
          throw error;
        }
      },
    });
  function touchCallerChief(caller?: ManagedRow) {
    if (caller && caller.role === "chief" && caller.state === "failed") {
      store.reactivate(caller.thread_id);
    }
  }
  return { registerChiefTool, touchCallerChief };
}

