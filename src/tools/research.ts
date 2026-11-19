import { researchParams } from "../research/research";
import type { Ctx } from "../runtime/context";

export function registerResearchTool(ctx: Ctx) {
  ctx.registerChiefTool({
    name: "chief_research",
    presentation: { label: { pending: "Researching…", completed: "Researched" } },
    description: "Start a read-only researcher thread for the ticket in `question`. It turns the ticket into neutral questions and sends them to 1-6 ticket-blind read-only helper threads. It reports through chief_report. The call returns at once; the report arrives as a lifecycle alert, so end your turn instead of polling. Chief only.",
    parameters: researchParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_research requires a thread context.");
      return ctx.research(params, context);
    },
  });}

