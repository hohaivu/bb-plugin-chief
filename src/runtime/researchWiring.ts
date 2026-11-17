import { createResearch } from "../research/research";
import { createWorkflowCli } from "../research/workflowCli";
import { terminal } from "../types";
import { clip } from "../core/text";
import { serverPath } from "../forge/forge";
import { execFileAsync } from "./exec";
import { MAX_RESULT_LENGTH } from "./constants";
import type { Ctx } from "./context";

export function createResearchWiring(ctx: Ctx) {
  const { bb, db } = ctx;
  const { research, researchSleep } = createResearch({
    db, bb, managedRow: ctx.managedRow, terminal, isActiveChief: ctx.isActiveChief, researchSettings: ctx.researchSettings,
    environmentHostId: ctx.environmentHostId, discover: ctx.discover, managedSpawn: ctx.managedSpawn,
    freshenCheckout: (chief) => ctx.freshenChiefCheckout(chief, "researcher"), projectHost: ctx.projectHost, projectHostId: ctx.projectHostId,
    clip, maxResultLength: MAX_RESULT_LENGTH,
  });
  const runWorkflowCli = createWorkflowCli({ serverPath, execFileAsync });
  return { research, researchSleep, runWorkflowCli };
}
