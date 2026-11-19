import { reportParams } from "../types";
import type { Ctx } from "../runtime/context";

export function registerReportTool(ctx: Ctx) {
  ctx.registerChiefTool({
    name: "chief_report",
    presentation: { label: { pending: "Reporting to Chief…", completed: "Reported to Chief" } },
    description: "Report work state and evidence to Chief. Use ready, not complete. Any length of result is accepted; an invalid report is refused with one line per field to fix.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_report requires a thread context.");
      const delivered = await ctx.intake.report(context.threadId, params, context.projectId);
      return delivered ? "Report delivered to Chief." : "Report queued for Chief; it will be delivered automatically. Do not report again.";
    },
  });}

