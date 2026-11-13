import { type ManagedRow } from "../types";
import { clip } from "../core/text";
import { forgeEnv, prHead } from "../forge/forge";
import { gitWithin } from "../review/impactSlice";
import { bounded, execFileAsync } from "../runtime/exec";
import type { Ctx } from "../runtime/context";

export const MAX_DIFF_CHARS = 500_000;
const DEADLINE_MS = 30_000;

/** Durable completion evidence for one worker: its pull request, base and head, the final diff (or why there is none) and the brief.
 * Taken before the completion write that queues cleanup, so cleanup can never clear what wave 3 grades from. */
export function createCompletionSnapshot(ctx: Ctx) {
  const { bb, db } = ctx;

  /** The diff `base...head` in the project checkout, read only from origin refs. Throws a short reason when it cannot be had. */
  async function readDiff(row: ManagedRow, deadline: number) {
    const path = await ctx.projectPath(row.project_id);
    if (!path) throw new Error("no local checkout of the project on the plugin server");
    const hostSkip = await ctx.checkoutHostSkip(row.project_id);
    if (hostSkip) throw new Error(hostSkip);
    let head: { branch: string; sha?: string; base?: string };
    if (row.pr_url) {
      const pr = await prHead(row.pr_url, path);
      if (!pr) throw new Error("head unreadable: cannot read the pull request head from the forge");
      head = pr;
    } else if (row.branch) head = { branch: row.branch };
    else throw new Error("no pull request or task branch");
    const env = forgeEnv();
    const git = gitWithin(path, env, deadline);
    const fetch = (...refs: string[]) => git(["fetch", "--no-tags", "origin", ...refs]).then(() => true, () => false);
    let baseRef: string;
    if (head.base) {
      if (!await fetch(head.base, head.branch)) throw new Error(`head unreadable: could not fetch origin/${head.base} and origin/${head.branch}`);
      baseRef = `origin/${head.base}`;
    } else {
      if (!await fetch(head.branch)) throw new Error(`head unreadable: could not fetch origin/${head.branch}`);
      baseRef = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
      if (!baseRef) throw new Error("origin/HEAD not set");
      if (!await fetch(baseRef.replace(/^origin\//, ""))) throw new Error(`could not fetch ${baseRef}`);
    }
    const sha = head.sha ?? (await git(["rev-parse", "--verify", `refs/remotes/origin/${head.branch}^{commit}`]).catch(() => "")).trim();
    if (!sha) throw new Error(`head unreadable: origin/${head.branch} not found after fetching it`);
    // The fetch above may not carry a pull request head that was force-pushed away: prove the commit is here.
    await git(["cat-file", "-e", `${sha}^{commit}`]).catch(() => { throw new Error(`head unreadable: ${sha.slice(0, 12)} not found after fetching origin/${head.branch}`); });
    // 4 bytes per character covers any text. A diff over maxBuffer is killed by node with the output so far in error.stdout: that is the truncated case, not a failure.
    let out: string;
    let cut = false;
    try {
      out = (await execFileAsync("git", ["diff", "--no-ext-diff", "--no-color", `${baseRef}...${sha}`], { cwd: path, env, timeout: Math.max(deadline - Date.now(), 1_000), maxBuffer: 4 * MAX_DIFF_CHARS })).stdout;
    } catch (error) {
      const partial = (error as { code?: unknown; stdout?: unknown });
      if (partial.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || typeof partial.stdout !== "string") throw error;
      out = partial.stdout;
      cut = true;
    }
    return { base: baseRef, headSha: sha, diff: out.slice(0, MAX_DIFF_CHARS), truncated: cut || out.length > MAX_DIFF_CHARS };
  }

  const insert = db.prepare(`INSERT OR REPLACE INTO chief_completions (thread_id, project_id, plan_thread_id, pr_url, base, head_sha, diff_state, diff_note, diff_path, brief_path, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  /** Never throws and never takes longer than 30 s: any failure is a row with diff_state 'unavailable' and its reason in diff_note. */
  async function snapshotCompletion(row: ManagedRow): Promise<void> {
    const record = { base: null as string | null, headSha: null as string | null, state: "unavailable" as "ok" | "truncated" | "unavailable", note: null as string | null, diffPath: null as string | null, briefPath: null as string | null };
    try {
      await bounded(async () => {
        const deadline = Date.now() + DEADLINE_MS;
        try {
          const found = await readDiff(row, deadline);
          record.base = found.base;
          record.headSha = found.headSha;
          record.diffPath = await ctx.writeArtifact(row.thread_id, row.project_id, "completion.diff", found.diff);
          record.state = found.truncated ? "truncated" : "ok";
          if (found.truncated) record.note = `diff clipped to ${MAX_DIFF_CHARS} characters`;
        } finally {
          record.briefPath = (await ctx.readArtifact(row.thread_id, row.project_id, "brief.md"))?.path ?? null;
        }
      }, DEADLINE_MS);
    } catch (error) {
      record.state = "unavailable";
      record.diffPath = null;
      record.note = clip(String((error as Error)?.message ?? error).replace(/\s+/g, " ").trim(), 300) || "diff unavailable";
    }
    try {
      insert.run(row.thread_id, row.project_id, row.plan_thread_id, row.pr_url, record.base, record.headSha, record.state, record.note, record.diffPath, record.briefPath, Date.now());
    } catch (error) {
      bb.log.warn(`Could not record ${row.thread_id}'s completion snapshot: ${String(error)}`);
    }
  }
  return { snapshotCompletion };
}
