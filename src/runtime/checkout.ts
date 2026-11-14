import { commitStamp, fastForward, stampLine } from "../forge/checkoutSync";
import { type ManagedRow, terminal } from "../types";
import { clip } from "../core/text";
import { bounded } from "./exec";
import { BUSY_STATUSES } from "./constants";
import { forgeEnv } from "../forge/forge";
import type { Ctx } from "./context";

export function createCheckout(ctx: Ctx) {
  const { bb, store } = ctx;
  /** Why the project's checkout path cannot be used here, or null when it is on the server's primary host.
   * The path names a checkout on the source's own host; only the server's primary host may read it. Never throws. */
  async function checkoutHostSkip(projectId: string): Promise<string | null> {
    let lookupError: unknown = "no source host recorded";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const project = await bb.sdk.projects.get({ projectId });
        const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
        if (!source?.hostId) break;
        return source.hostId === (await bb.sdk.system.config()).primaryHostId ? null : "the project checkout is on a remote host, not the plugin server";
      } catch (error) { lookupError = error; }
    }
    return `could not confirm which host holds the project checkout (${clip(String(lookupError), 200)})`;
  }

  const FRESHEN_MS = 30_000;
  const STAGE_READ_MS = 5_000;
  const STAMP_MS = 12_000;

  /** A read-only SDK lookup bounded by min(5 s, time left before `deadline`); with no time left it never starts.
   * An abandoned lookup has no continuation into this code: the caller has already moved on through the rejection. */
  function stageRead(deadline: number) {
    return <T>(call: () => Promise<T>): Promise<T> => {
      const left = deadline - Date.now();
      return left <= 0 ? Promise.reject(new Error("timed out")) : bounded(call, Math.min(STAGE_READ_MS, left));
    };
  }

  type ServerCheckout = { path: string; branch: string } | { path: string | null; skipped: string };

  /** The checkout of `threadId`'s environment, when it is on the plugin server's primary host and has a default branch. Never throws. */
  async function serverCheckout(threadId: string, read: ReturnType<typeof stageRead>): Promise<ServerCheckout> {
    let path: string | null = null;
    try {
      const { environmentId } = await read(() => bb.sdk.threads.get({ threadId }));
      if (!environmentId) return { path, skipped: "no environment" };
      const environment = await read(() => bb.sdk.environments.get({ environmentId }));
      if (!environment.path) return { path, skipped: "no checkout path" };
      path = environment.path;
      if (!environment.defaultBranch) return { path, skipped: "default branch unknown" };
      if (environment.hostId !== (await read(() => bb.sdk.system.config())).primaryHostId) return { path, skipped: "the checkout is on a remote host, not the plugin server" };
      return { path, branch: environment.defaultBranch };
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      return { path, skipped: message === "timed out" || message === "deadline passed" ? "timed out" : clip(message, 200) };
    }
  }

  /** Fast-forwards Chief's checkout before a researcher, or a planner that shares it, starts, or when Chief asks (chief_sync). Returns the old and new commit, a warning line when it did not, or null when a planner has a separate checkout. Never throws.
   * Nothing that reaches git is raced: every git call is awaited to exit, so when this returns no git it started is running or can start. */
  async function syncChiefCheckout(chief: ManagedRow, reader: "researcher" | "planner" | "chief"): Promise<{ from: string; to: string } | { warning: string } | null> {
    const warn = (reason: string, branch?: string) => ({ warning: `Did not fast-forward your checkout to origin/${branch ?? "the default branch"}: ${reason}. ${reader === "chief" ? "You read" : `The ${reader} reads`} it as it is.` });
    try {
      const deadline = Date.now() + FRESHEN_MS;
      const read = stageRead(deadline);
      const co = await serverCheckout(chief.thread_id, read);
      const source = co.path ? await read(() => ctx.projectPath(chief.project_id)).catch(() => null) : null;
      // A failed lookup is "unknown", never "no": only two known, different paths prove a separate checkout.
      const sharing = co.path && source ? (co.path === source ? "yes" : "no") : "unknown";
      if (reader === "planner" && sharing === "no") return null;
      if (reader === "planner" && sharing === "unknown") {
        return warn(`could not tell whether the planner shares it (${co.path ? "project checkout path unknown" : (co as { skipped: string }).skipped})`);
      }
      if ("skipped" in co) return warn(co.skipped);
      const candidates = store.all().filter((row) => row.chief_thread_id === chief.thread_id && !terminal(row.state)
        // A row with a recorded branch runs in its own managed worktree, never in Chief's checkout.
        && ((row.role === "researcher" && !row.branch) || (row.role === "planner" && !row.branch && sharing !== "no")));
      // A live read that fails or times out counts as running.
      const running = (await Promise.all(candidates.map(async (row) => {
        const live = await read(() => bb.sdk.threads.get({ threadId: row.thread_id })).catch(() => null);
        return !live || BUSY_STATUSES.has(live.status) ? row : null;
      }))).find((row) => row);
      if (running) return warn(`${running.role} ${running.thread_id} is still running in it`, co.branch);
      const result = await fastForward({ cwd: co.path, env: forgeEnv(), branch: co.branch, deadline });
      return "skipped" in result ? warn(result.skipped, co.branch) : result;
    } catch (error) {
      return warn(clip(String((error as Error)?.message ?? error), 200));
    }
  }

  /** The researcher and planner callers want only the warning line. */
  async function freshenChiefCheckout(chief: ManagedRow, reader: "researcher" | "planner"): Promise<string | null> {
    const result = await syncChiefCheckout(chief, reader);
    return result && "warning" in result ? result.warning : null;
  }

  /** `Read at <sha>[; <branch> is now <sha>, so this answer may be stale]` for the checkout `threadId` runs in, or null. Never throws, no outer deadline:
   * the local SHA is kept once read, and a slow `ls-remote` only drops the comparison. */
  async function reportStamp(threadId: string): Promise<string | null> {
    try {
      const deadline = Date.now() + STAMP_MS;
      const co = await serverCheckout(threadId, stageRead(deadline));
      if ("skipped" in co) return null;
      // The reader's own selected branch, else its environment's default branch.
      const branch = store.get(threadId)?.branch ?? co.branch;
      const stamp = await commitStamp({ cwd: co.path, env: forgeEnv(), branch, deadline });
      return stamp ? stampLine(stamp, branch) : null;
    } catch {
      return null;
    }
  }
  return { checkoutHostSkip, freshenChiefCheckout, reportStamp, syncChiefCheckout };
}

