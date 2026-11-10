import { researchParams } from "../research/research";
import type { Ctx } from "../runtime/context";

export function registerResearchTool(ctx: Ctx) {
  ctx.registerChiefTool({
    name: "chief_research",
    presentation: { label: { pending: "Researching…", completed: "Researched" } },
    description: [
      "Fan a read-only question out to parallel BB workflow agents. survey: answer `question` for each of `items` (files, symbols, topics), one verified row each with evidence.",
      "investigate: one agent per `questions` entry, then one merges the answers into a brief with Confirmed and Unconfirmed sections.",
      "Chief, planners and researchers may use survey and investigate. Reviewers, workers and advisors cannot use it.",
      "Read-only by prompt only: the agents share your checkout and permissions, and are told not to edit, commit, or push.",
      "From Chief the call returns at once with the id of a researcher thread that runs the research in your checkout and reports through chief_report; its report arrives as a lifecycle alert, so end your turn instead of polling.",
      "From a planner, each call waits up to the mode's timeout (10 minutes unless set in Chief researcher settings), and never more than 2.5 minutes, because some providers end tool calls at 3 minutes. If the run is still going it returns its runId: call chief_research again with the same mode and that runId to keep waiting; the run keeps going in between.",
    ].join(" "),
    parameters: researchParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_research requires a thread context.");
      return ctx.research(params, context);
    },
  });}

