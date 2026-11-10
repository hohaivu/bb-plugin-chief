import { logParams } from "./shapes";
import type { Ctx } from "../runtime/context";

export function registerLogTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_log",
    presentation: { label: { pending: "Reading plan log…", completed: "Read plan log" } },
    description: "Plan workers only: append FACT/FAIL notes for peer waves, and read unread peer notes plus every wave's current worker and state. Never alerts Chief or changes your state.",
    parameters: logParams,
    async execute({ entries }, context) {
      const row = context.threadId ? store.get(context.threadId) : undefined;
      if (!row || row.role !== "worker" || !row.plan_thread_id) return "Not part of a plan run.";
      return ctx.planLog(row, entries);
    },
  });}

