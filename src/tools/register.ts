import { type ManagedRow } from "../types";
import { z } from "zod";
import { COORDINATOR_REFUSED, coordinatorRefusal } from "../runtime/prompts";
import type { Ctx } from "../runtime/context";

export function createToolRegistry(ctx: Ctx) {
  const { bb, store } = ctx;
  /** bb.agents.registerTool, except that a tool in COORDINATOR_REFUSED refuses a Coordinator caller before it reads any input.
   * A failed call is also ledgered (tool name and first message line only); that observing never replaces the tool's own error. */
  const registerChiefTool = <Schema extends z.ZodType>(tool: Parameters<typeof bb.agents.registerTool<Schema>>[0]) => {
    const inner: typeof tool.execute = COORDINATOR_REFUSED.has(tool.name)
      ? (params, context) => {
        if (ctx.isCoordinator(context.threadId ? store.get(context.threadId) : undefined)) throw new Error(coordinatorRefusal(tool.name));
        return tool.execute(params, context);
      }
      : tool.execute;
    bb.agents.registerTool({
      ...tool,
      execute: async (params, context) => {
        try {
          return await inner(params, context);
        } catch (error) {
          try { ctx.observe.toolError(tool.name, context.threadId, context.projectId, error); } catch { /* observing must never replace the tool's error */ }
          throw error;
        }
      },
    });
  };
  function touchCallerChief(caller?: ManagedRow) {
    if (caller && caller.role === "chief" && caller.state === "failed") {
      store.reactivate(caller.thread_id);
    }
  }
  return { registerChiefTool, touchCallerChief };
}

