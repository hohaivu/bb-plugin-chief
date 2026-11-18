import { researchParams } from "../research/research";
import type { Ctx } from "../runtime/context";

export function registerResearchTool(ctx: Ctx) {
  ctx.registerChiefTool({
    name: "chief_research",
    presentation: { label: { pending: "Researching…", completed: "Researched" } },
    description: "Start a read-only researcher thread for the ticket in `question`. It works in your checkout (or, with `branch`, a fresh worktree on that branch), turns the ticket into neutral questions and sends them to 1-6 ticket-blind read-only helper threads. `design: false` reports facts only (evidence checks); `design: true` then holds a design discussion with the user in its thread and reports a design.md the user approved (features and multi-file work). It reports through chief_report. The call returns at once; the report arrives as a lifecycle alert, so end your turn instead of polling. Chief only.",
    parameters: researchParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_research requires a thread context.");
      return ctx.research(params, context);
    },
  });}

