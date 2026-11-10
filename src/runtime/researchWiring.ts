import { createResearch } from "../research/research";
import { terminal } from "../types";
import { clip } from "../core/text";
import { serverPath } from "../forge/forge";
import { execFileAsync } from "./exec";
import { MAX_RESULT_LENGTH } from "./constants";
import type { Ctx } from "./context";

export function createResearchWiring(ctx: Ctx) {
  const { anyCooldown, bb, db, store } = ctx;
  const { research, researchSleep, checkUnreported } = createResearch({
    db, bb, managedRow: ctx.managedRow, roleRow: store.get, terminal, isActiveChief: ctx.isActiveChief, researchSettings: ctx.researchSettings, readResearchModel: ctx.readResearchModel,
    environmentHostId: ctx.environmentHostId, discover: ctx.discover, catalogReader: ctx.catalogReader, usableSelection: ctx.usableSelection, anyCooldown, cooldownError: ctx.cooldownError, noteCooldown: ctx.noteCooldown, lastProviderError: ctx.lastProviderError,
    lastOutput: ctx.lastOutput, managedSpawn: ctx.managedSpawn, alertChief: ctx.alertChief, freshenCheckout: (chief) => ctx.freshenChiefCheckout(chief, "researcher"), writeArtifact: ctx.writeArtifact, serverPath, clip, execFileAsync,
    maxResultLength: MAX_RESULT_LENGTH,
  });
  return { checkUnreported, research, researchSleep };
}

