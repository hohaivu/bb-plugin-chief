import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { createState, type Ctx } from "./src/runtime/context";
import { createCore } from "./src/runtime/core";
import { createObserve } from "./src/observe/events";
import { createCompletionSnapshot } from "./src/observe/completionSnapshot";
import { runDailyReport } from "./src/observe/report";
import { createSweep } from "./src/runtime/sweep";
import { createSettingsRuntime } from "./src/runtime/settings";
import { createChiefs } from "./src/runtime/chiefs";
import { createDelegation } from "./src/runtime/delegation";
import { createNextAction } from "./src/runtime/nextAction";
import { createCheckout } from "./src/runtime/checkout";
import { createCleanup } from "./src/runtime/cleanup";
import { createCompletion } from "./src/runtime/completion";
import { createAlerts } from "./src/runtime/alerts";
import { createForgeWiring } from "./src/runtime/forgeWiring";
import { createArtifacts } from "./src/runtime/artifacts";
import { createLifecycle, registerLifecycle } from "./src/runtime/lifecycle";
import { createRoster } from "./src/runtime/roster";
import { createInspect } from "./src/runtime/inspect";
import { createResearchWiring } from "./src/runtime/researchWiring";
import { createToolRegistry } from "./src/tools/register";
import { registerForgeInitTool } from "./src/tools/forgeInit";
import { registerDelegateTool } from "./src/tools/delegate";
import { registerPlanTool } from "./src/tools/plan";
import { registerSpawnTool } from "./src/tools/spawn";
import { registerCoordinateTool } from "./src/tools/coordinate";
import { registerAttachTool } from "./src/tools/attach";
import { registerConsultTool } from "./src/tools/consult";
import { registerRosterTool } from "./src/tools/roster";
import { registerInspectTool } from "./src/tools/inspect";
import { registerContinueTool } from "./src/tools/continue";
import { registerStopTool } from "./src/tools/stop";
import { registerReviewTool } from "./src/tools/review";
import { registerCompleteTool } from "./src/tools/complete";
import { registerOwnerApprovalTool } from "./src/tools/ownerApproval";
import { registerSkipTestsTool } from "./src/tools/skipTests";
import { registerSkipSpecsTool } from "./src/tools/skipSpecs";
import { registerEscalateTool } from "./src/tools/escalate";
import { registerSyncTool } from "./src/tools/sync";
import { registerReportTool } from "./src/tools/report";
import { registerLogTool } from "./src/tools/log";
import { registerResearchTool } from "./src/tools/research";
import { registerHost } from "./src/runtime/host";
import { registerCli } from "./src/runtime/cli";
import type { FailEntry, ManagedRow, ManagedThread, ModelConfiguration, ModelSelection, ReportFinding, ReportParams } from "./src/types";

export { RESEARCH_SCRIPTS } from "./src/research/research";
export { MIGRATIONS } from "./src/db/migrations";
export { rpcContract } from "./src/rpcContract";
export type { ResearchConfiguration } from "./src/research/research";
export type { ManagedRow, ManagedThread, FailEntry, ReportFinding, ReportParams, ModelConfiguration, ModelSelection };

export default async function plugin(bb: BbPluginApi) {
  const ctx = { bb, state: createState() } as Ctx;
  Object.assign(ctx, createCore(ctx));
  Object.assign(ctx, createObserve(ctx)); // with the original bb: its own warn feeds Sentry
  // Every module built after this sees a bb whose log.warn also reports to Sentry; a Proxy keeps the SDK object's own `this`.
  const log = { debug: (m: string) => bb.log.debug(m), info: (m: string) => bb.log.info(m), error: (m: string) => bb.log.error(m), warn: (m: string) => { bb.log.warn(m); ctx.observe.warn(m); } };
  ctx.bb = new Proxy(bb, { get: (target, prop) => { const value = prop === "log" ? log : Reflect.get(target, prop, target); return typeof value === "function" ? value.bind(target) : value; } });
  Object.assign(ctx, createSweep(ctx));
  Object.assign(ctx, createSettingsRuntime(ctx));
  Object.assign(ctx, createChiefs(ctx));
  Object.assign(ctx, createDelegation(ctx));
  Object.assign(ctx, createNextAction(ctx));
  Object.assign(ctx, createCheckout(ctx));
  Object.assign(ctx, createCleanup(ctx));
  Object.assign(ctx, createCompletionSnapshot(ctx));
  Object.assign(ctx, createCompletion(ctx));
  Object.assign(ctx, createAlerts(ctx));
  Object.assign(ctx, createForgeWiring(ctx));
  Object.assign(ctx, createArtifacts(ctx));
  Object.assign(ctx, createLifecycle(ctx));
  registerLifecycle(ctx);
  Object.assign(ctx, createRoster(ctx));
  Object.assign(ctx, createInspect(ctx));
  Object.assign(ctx, createResearchWiring(ctx));
  Object.assign(ctx, createToolRegistry(ctx));
  registerForgeInitTool(ctx);
  registerDelegateTool(ctx);
  registerPlanTool(ctx);
  registerSpawnTool(ctx);
  registerCoordinateTool(ctx);
  registerAttachTool(ctx);
  registerConsultTool(ctx);
  registerRosterTool(ctx);
  registerInspectTool(ctx);
  registerContinueTool(ctx);
  registerStopTool(ctx);
  registerReviewTool(ctx);
  registerCompleteTool(ctx);
  registerOwnerApprovalTool(ctx);
  registerSkipTestsTool(ctx);
  registerSkipSpecsTool(ctx);
  registerEscalateTool(ctx);
  registerSyncTool(ctx);
  registerReportTool(ctx);
  registerLogTool(ctx);
  registerResearchTool(ctx);
  ctx.bb.background.schedule("daily-report", "0 8 * * *", async () => { await runDailyReport(ctx); });
  registerHost(ctx);
  registerCli(ctx);
  const { settings, store } = ctx;

  ctx.state.pendingReady = true;
  for (const chief of store.all().filter(ctx.isActiveChief)) void ctx.unpinPendingTab(chief.thread_id);
  try {
    await ctx.reconcile(); // each reconciled row's reload sweeps rows absorbed before this version
  } catch (error) {
    ctx.bb.log.warn(`Initial reconciliation deferred: ${String(error)}`);
  }
  store.reload();
  await ctx.state.sweeping;
  await ctx.plannerEnabled().catch((error) => ctx.bb.log.warn(`Could not read the planner setting: ${String(error)}`));
  await ctx.researchSettings().catch((error) => ctx.bb.log.warn(`Could not read the researcher settings: ${String(error)}`));
  const initial = await settings.get();
  ctx.state.cleanupActive = initial.cleanupApproved;
  if (initial.autoSpawn && initial.chiefProject) {
    void ctx.ensureChief(initial.chiefProject).catch((error) => ctx.bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
  }
  bb.log.info("Chief supervisor loaded");
}
