// The only file that knows bb Tasks: its CLI, statuses, labels and comment kinds.
// Every call runs without a thread identity (no BB_THREAD_ID), so Tasks records Chief's comments as plain user comments
// and its native Notify never routes an owner reply to Chief; the plugin poll in trackerSync is the one answer path.

import type { ExecFileOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Tracker, TrackerComment, TrackerStatus } from "./tracker";

export interface BbTasksDeps {
  execFileAsync: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
  serverPath: () => string;
}

const TASKS_TIMEOUT_MS = 30_000;
const AVAILABLE_TTL_MS = 5 * 60_000;
const DECISION_LABEL = "needs-decision";
const parse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
const STATUS: Record<TrackerStatus, string> = { planning: "todo", working: "in_progress", review: "in_review", done: "done" };

export function bbTasksTracker(deps: BbTasksDeps): Tracker {
  /** Runs `bb tasks <args> --json` as the server, not as a thread. A failure throws "<code>: <message>". */
  async function run(args: string[]) {
    const { BB_THREAD_ID: _thread, BB_PROJECT_ID: _project, ...env } = process.env;
    let stdout: string;
    try {
      ({ stdout } = await deps.execFileAsync(process.env.BB_CLI ?? "bb", ["tasks", ...args, "--json"], {
        env: { ...env, PATH: deps.serverPath() }, timeout: TASKS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      const failed = parse(String((error as { stdout?: unknown }).stdout ?? ""));
      throw new Error(failed?.error ? `${failed.error.code}: ${failed.error.message}` : error instanceof Error ? error.message : String(error));
    }
    const parsed = parse(stdout);
    if (parsed?.ok === false) throw new Error(`${parsed.error?.code}: ${parsed.error?.message}`);
    return parsed ?? {};
  }

  const show = (taskId: string) => run(["show", taskId]);
  let probe: { at: number; ok: boolean } | null = null;
  const labelled = new Set<string>();

  return {
    async available() {
      if (probe && Date.now() - probe.at < AVAILABLE_TTL_MS) return probe.ok;
      const ok = await run(["status"]).then(() => true, () => false);
      probe = { at: Date.now(), ok };
      return ok;
    },
    async findTask(project, marker) {
      const { tasks } = await run(["list", "--project", project, "--search", marker]);
      return (tasks as { id: string; description?: string }[] | undefined)?.find((task) => task.description?.includes(marker))?.id ?? null;
    },
    async createTask({ project, title, description }) {
      const created = await run(["create", "--project", project, "--title", title, "--description", description]);
      const id = created.task?.id ?? created.id;
      if (typeof id !== "string") throw new Error("create returned no task id");
      return id;
    },
    async setStatus(taskId, status) {
      await run(["update", taskId, "--status", STATUS[status]]);
    },
    async attachThread(taskId, threadId) {
      await run(["attach", taskId, "--thread", threadId]);
    },
    async detachThread(taskId, threadId) {
      await run(["detach", taskId, "--thread", threadId]);
    },
    async linkPullRequest(taskId, url) {
      const description: string = (await show(taskId)).task?.description ?? "";
      if (description.includes(url)) return;
      await run(["update", taskId, "--description", `${description}\nPull request: ${url}`]);
    },
    async attachFile(taskId, file) {
      const dir = await mkdtemp(join(tmpdir(), "chief-tracker-"));
      try {
        const name = basename(file.name);
        const path = join(dir, name);
        await writeFile(path, file.content);
        await run(["attachment", "add", taskId, "--file", path, "--name", name]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async comments(taskId) {
      const { comments } = await show(taskId);
      return ((comments ?? []) as { id: string; kind: string; body: string; createdAt: string }[]).map((comment): TrackerComment => ({
        id: comment.id, byOwner: comment.kind === "user", body: comment.body, at: Date.parse(comment.createdAt),
      }));
    },
    async postComment(taskId, body) {
      const posted = await run(["comment", taskId, "--body", body, "--author", "Chief"]);
      const id = posted.comment?.id ?? posted.id;
      if (typeof id !== "string") throw new Error("comment returned no comment id");
      return id;
    },
    async setDecisionFlag(project, taskId, open) {
      if (open && !labelled.has(project)) {
        const { labels } = await run(["label", "list", "--project", project]);
        if (!(labels as { name: string }[] | undefined)?.some((label) => label.name === DECISION_LABEL)) {
          await run(["label", "create", "--project", project, "--name", DECISION_LABEL]);
        }
        labelled.add(project);
      }
      await run(["update", taskId, open ? "--add-label" : "--remove-label", DECISION_LABEL]);
    },
  };
}

/** Maps the `tracker` setting to an adapter: only the exact trimmed name `bb-tasks`. One instance per selector, so its caches persist. */
export function trackerSelector(deps: BbTasksDeps): (raw: unknown) => Tracker | null {
  let adapter: Tracker | null = null;
  return (raw) => typeof raw === "string" && raw.trim() === "bb-tasks" ? (adapter ??= bbTasksTracker(deps)) : null;
}
