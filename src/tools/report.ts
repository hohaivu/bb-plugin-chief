import { reportParams } from "../types";
import type { Ctx } from "../runtime/context";

export function registerReportTool(ctx: Ctx) {
  ctx.registerChiefTool({
    name: "chief_report",
    presentation: { label: { pending: "Reporting to Chief…", completed: "Reported to Chief" } },
    description: "Report managed work state and evidence to Chief. Use ready, not complete; blocked requires blocker and recommendation; a reviewer's ready report requires a verdict and findings; a planner's ready report requires plan (the full plan body), which Chief receives as a file, and may set complex; a plan review's ready report requires a verdict. Send a short `summary` with a long `result`; the full result is saved to a per-report file. Any length of result is accepted; an invalid report is refused with one line per field to fix.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_report requires a thread context.");
      const delivered = await ctx.intake.report(context.threadId, params, context.projectId);
      return delivered ? "Report delivered to Chief." : "Report queued for Chief; it will be delivered automatically. Do not report again.";
    },
  });}

