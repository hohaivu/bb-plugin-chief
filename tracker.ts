// The task-tracker protocol: provider-independent types only. No I/O, no provider names, no registry.
// An adapter implements Tracker; trackerSync mirrors Chief's work through it.

export type TrackerStatus = "planning" | "working" | "review" | "done";
export type TrackerComment = { id: string; byOwner: boolean; body: string; at: number };

export interface Tracker {
  available(): Promise<boolean>;
  /** The id of the task whose description contains marker, or null. */
  findTask(project: string, marker: string): Promise<string | null>;
  /** Returns an opaque task id. */
  createTask(input: { project: string; title: string; description: string }): Promise<string>;
  setStatus(taskId: string, status: TrackerStatus): Promise<void>;
  attachThread(taskId: string, threadId: string): Promise<void>;
  detachThread(taskId: string, threadId: string): Promise<void>;
  /** Idempotent. */
  linkPullRequest(taskId: string, url: string): Promise<void>;
  attachFile(taskId: string, file: { name: string; content: string }): Promise<void>;
  /** Oldest first. */
  comments(taskId: string): Promise<TrackerComment[]>;
  /** Posts body verbatim and returns the comment id. */
  postDecision(taskId: string, body: string): Promise<string>;
  setDecisionFlag(project: string, taskId: string, open: boolean): Promise<void>;
}

/** "proj_x=KEY" entries split on newlines or commas; trimmed; malformed entries ignored; the last entry for a project wins. */
export function trackerProjects(raw: unknown): Map<string, string> {
  const projects = new Map<string, string>();
  if (typeof raw !== "string") return projects;
  for (const entry of raw.split(/[\n,]/)) {
    const [project, key, ...rest] = entry.split("=").map((part) => part.trim());
    if (project && key && !rest.length) projects.set(project, key);
  }
  return projects;
}
