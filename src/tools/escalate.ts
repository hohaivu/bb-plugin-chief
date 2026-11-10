import { createHash } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "../runtime/context";

export function registerEscalateTool(ctx: Ctx) {
  const { ledger, store } = ctx;
  ctx.registerChiefTool({
    name: "chief_escalate",
    presentation: { label: { pending: "Posting escalation…", completed: "Posted escalation" } },
    description: "Before you write a **Need you** request in chat, post it on the managed thread's pull request (else its tracking issue) with an @mention of the owner, so it is on record where the work is. threadId is the managed thread the request concerns; request is the full request. It returns at once; the post happens in the background. A planner with no tracking issue yet returns \"chat only\": then write the request in chat alone. Calling it again with the same request posts nothing new. Omit threadId only when no managed thread concerns the request yet.",
    parameters: z.object({
      threadId: z.string().optional(),
      request: z.string().trim().min(1).max(12_000).describe("The full request, as you will write it in chat under Need you."),
      merge: z.boolean().optional().describe("true when the request only asks permission to merge: no tracker decision is posted"),
    }),
    async execute({ threadId, request, merge }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!ctx.isActiveChief(caller)) throw new Error(threadId === undefined ? "chief_escalate requires an active registered Chief thread." : `No managed thread ${threadId} for this Chief.`);
      const concerned = threadId === undefined ? undefined : await ctx.controlledTarget(threadId, caller);
      ctx.touchCallerChief(caller);
      const chatOnly = "No pull request or issue to post on; write the request in chat only.";
      ctx.alertCoordinator(caller, { kind: "need-you", request, concerned });
      if (!concerned) return chatOnly;
      const url = concerned.pr_url ?? concerned.issue_url
        ?? (concerned.role === "reviewer" ? ledger.targets(concerned.thread_id).map((target) => target.pr_url ?? store.get(target.worker_thread_id)?.pr_url).find(Boolean) : undefined)
        ?? (concerned.role === "planner" ? concerned.plan_issue_url : undefined);
      if (!merge) void ctx.trackerSync.decide(concerned, request);
      if (!url) return chatOnly;
      const id = `escalate:${threadId}:${createHash("sha1").update(request).digest("hex").slice(0, 12)}`;
      const queued = ctx.forgeComments.enqueue({
        key: id, row: concerned, target: url, mention: true,
        comment: { title: "Need you", lines: [ctx.forgeText(request, 12_000)] },
      });
      return queued ? `Queued for ${url}. Now write the same request in chat under **Need you**.` : chatOnly;
    },
  });}

