import { z } from "zod";
import type { Ctx } from "../runtime/context";

export function registerSyncTool(ctx: Ctx) {
  const { store } = ctx;
  ctx.registerChiefTool({
    name: "chief_sync",
    presentation: { label: { pending: "Syncing checkout…", completed: "Synced checkout" } },
    description: "Fast-forward your own checkout to origin's default branch before you read code yourself. It never overwrites uncommitted or ignored files and never errors on a skip: it returns the old and new commit, or why it left the checkout as it is (a researcher or sharing planner is running, uncommitted changes, commits of its own, a failed fetch).",
    parameters: z.object({}),
    async execute(_params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error("chief_sync is for the Chief thread.");
      ctx.touchCallerChief(caller);
      const result = await ctx.syncChiefCheckout(caller, "chief");
      if (!result) return "Nothing to sync.";
      if ("warning" in result) return result.warning;
      return result.from === result.to ? `Your checkout is already at ${result.to.slice(0, 12)}.` : `Fast-forwarded your checkout from ${result.from.slice(0, 12)} to ${result.to.slice(0, 12)}.`;
    },
  });}

