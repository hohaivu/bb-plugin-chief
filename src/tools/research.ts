import { researchParams } from "../research/research";
import type { Ctx } from "../runtime/context";

export function registerResearchTool(ctx: Ctx) {
  ctx.registerChiefTool({
    name: "chief_research",
    presentation: { label: { pending: "Researching…", completed: "Researched" } },
    description: "Start a read-only researcher thread for `question`. It works in your checkout (or, with `branch`, a fresh worktree on that branch), decides whether to answer alone or split the question across up to 6 read-only helper threads, and reports through chief_report. The call returns at once; the report arrives as a lifecycle alert, so end your turn instead of polling. Chief only.",
    parameters: researchParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_research requires a thread context.");
      return ctx.research(params, context);
    },
  });}

