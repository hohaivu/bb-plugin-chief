import { stopParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerStopTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_stop",
    presentation: { label: { pending: "Stopping thread…", completed: "Stopped thread" } },
    description: "Interrupt a running managed thread that is stuck or looping. Keeps its worktree, branch, and history; the reply names the reroute steps.",
    parameters: stopParams,
    async execute({ threadId, reason }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error("chief_stop requires an active registered Chief thread.");
      await ctx.controlledTarget(threadId, caller);
      ctx.touchCallerChief(caller);
      const row = await ctx.stopThread(threadId, reason);
      return `Stopped “${row.title}” (${threadId}). Its worktree, branch, and history are kept. ${ctx.rerouteSteps(row)}`;
    },
  });}

