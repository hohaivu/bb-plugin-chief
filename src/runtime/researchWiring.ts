import { createResearch } from "../research/research";
import { terminal } from "../types";
import { clip } from "../core/text";
import { MAX_RESULT_LENGTH } from "./constants";
import type { Ctx } from "./context";

export function createResearchWiring(ctx: Ctx) {
  const { bb, db } = ctx;
  const { research } = createResearch({
    db, bb, managedRow: ctx.managedRow, terminal, isActiveChief: ctx.isActiveChief, researchSettings: ctx.researchSettings,
    environmentHostId: ctx.environmentHostId, discover: ctx.discover, managedSpawn: ctx.managedSpawn,
    // Only an explicit pick resolves here; no pick returns null and the helpers reuse the researcher's resolved execution.
    helperExecution: async (hostId, projectId) => hostId && ctx.readRoleModel(hostId, "research-helper") ? ctx.spawnExecution("research-helper", hostId, projectId) : null,
    freshenCheckout: (chief) => ctx.freshenChiefCheckout(chief, "researcher"), projectHost: ctx.projectHost, projectHostId: ctx.projectHostId,
    clip, maxResultLength: MAX_RESULT_LENGTH,
  });
  return { research };
}
