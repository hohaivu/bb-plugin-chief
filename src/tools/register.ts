import { type ManagedRow } from "../types";
import { z } from "zod";
import { COORDINATOR_REFUSED, coordinatorRefusal } from "../runtime/prompts";
import type { Ctx } from "../runtime/context";

export function createToolRegistry(ctx: Ctx) {
  const { bb, store } = ctx;
  /** bb.agents.registerTool, except that a tool in COORDINATOR_REFUSED refuses a Coordinator caller before it reads any input. */
  const registerChiefTool = <Schema extends z.ZodType>(tool: Parameters<typeof bb.agents.registerTool<Schema>>[0]) =>
    bb.agents.registerTool(COORDINATOR_REFUSED.has(tool.name) ? {
      ...tool,
      execute: (params, context) => {
        if (ctx.isCoordinator(context.threadId ? store.get(context.threadId) : undefined)) throw new Error(coordinatorRefusal(tool.name));
        return tool.execute(params, context);
      },
    } : tool);
  function touchCallerChief(caller?: ManagedRow) {
    if (caller && caller.role === "chief" && caller.state === "failed") {
      store.reactivate(caller.thread_id);
    }
  }
  return { registerChiefTool, touchCallerChief };
}

