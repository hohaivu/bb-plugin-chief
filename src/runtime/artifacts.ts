import { type ManagedRow } from "../types";
import { type ThreadInsert } from "../db/threadStore";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Ctx } from "./context";

  export type ThreadInput = ThreadInsert<ManagedRow["role"], ManagedRow["state"]>;

export function createArtifacts(ctx: Ctx) {
  const { bb, db } = ctx;
  // A disposed instance's writes fail on a stale handle: its row stays for the next generation to replay.
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  /** The server, not the planner, owns writing the plan: the planner submits it
   * through chief_report and this lands it in the shared artifact folder (see artifactDir). */
  async function writePlan(threadId: string, projectId: string, plan: string | { body: string }[], mirrorFor?: string) {
    const bodies = typeof plan === "string" ? [{ name: "plan.md", body: plan }]
      : plan.map((wave, index) => ({ name: `plan-${index + 1}.md`, body: wave.body }));
    const paths = [];
    // mirrorFor writes a render copy under that thread's storage, in plans/<threadId>/: inline-vis only reads thread storage.
    for (const wave of bodies) {
      const content = `${wave.body}\n`;
      paths.push({ path: mirrorFor ? await writeStorageFile(mirrorFor, join("plans", threadId, wave.name), content)
        : await writeArtifact(threadId, projectId, wave.name, content) });
    }
    return paths;
  }
  async function artifactDir(threadId: string, projectId: string, onHost?: string) {
    // A named host skips storageLocation, which answers HTTP 409 while a new environment provisions.
    const location = onHost ? null : await bb.sdk.threads.storageLocation({ threadId });
    const hostId = onHost ?? location!.hostId;
    if (!ctx.state.dataDirs.has(hostId)) {
      // ponytail: per-process cache; a moved BB data dir needs a plugin reload
      let reason = "its thread storage root is unknown";
      const dataDir = await bb.sdk.hosts.get({ hostId }).then((host) => host.threadStorageRootPath ? dirname(host.threadStorageRootPath) : null)
        .catch((error) => { reason = `reading it failed: ${String(error)}`; return null; });
      if (dataDir) ctx.state.dataDirs.set(hostId, dataDir);
      else if (onHost) throw new Error(`Host ${hostId}'s BB data dir is unavailable (${reason})`); // the thread's storage root is on another host
      else {
        bb.log.warn(`Host ${hostId}'s BB data dir is unavailable (${reason}); writing Chief artifacts to thread storage instead.`);
        // Recorded before the path is used, so a thread's storage that holds evidence is never cleared; if this throws, so does the artifact write.
        db.prepare(`INSERT OR IGNORE INTO artifact_fallbacks (thread_id, at) VALUES (?, ?)`).run(threadId, Date.now());
        return { hostId, dir: location!.storageRootPath };
      }
    }
    return { hostId, dir: join(ctx.state.dataDirs.get(hostId)!, "chief", projectId, threadId) };
  }

  /** Writes one of Chief's artifacts to its shared folder and returns the absolute path. */
  async function writeArtifact(threadId: string, projectId: string, name: string, content: string, onHost?: string) {
    const { hostId, dir } = await artifactDir(threadId, projectId, onHost);
    return atomicWrite(hostId, join(dir, name), content);
  }

  /** Writes a file under a thread's own storage root and returns its absolute path. */
  async function writeStorageFile(threadId: string, relPath: string, content: string) {
    const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({ threadId });
    // Thread storage lives on the thread's host, which need not be this plugin server's machine.
    return atomicWrite(hostId, join(storageRootPath, relPath), content);
  }

  /** The content lands under a temp name and is moved into place, so a failed write never leaves a partial file under
   * the final name. An existing file at the path is replaced (remove, then move): a reader may briefly see it missing,
   * and a failed second move loses the old version. */
  async function atomicWrite(hostId: string, path: string, content: string) {
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      await bb.sdk.files.write({ hostId, path: tmp, content, createParents: true });
      try {
        await bb.sdk.files.move({ hostId, sourcePath: tmp, destinationPath: path });
      } catch (error) {
        // shortcut: the host's message text is how we detect an existing destination; upgrade when FileMoveArgs gets an overwrite flag.
        if (!/already exists/i.test(String((error as Error)?.message ?? error))) throw error;
        await bb.sdk.files.remove({ hostId, path });
        await bb.sdk.files.move({ hostId, sourcePath: tmp, destinationPath: path });
      }
    } catch (error) {
      await bb.sdk.files.remove({ hostId, path: tmp }).catch(() => undefined);
      throw error;
    }
    return path;
  }

  /** The artifact's path and text, or null when it is missing or unreadable. Never throws. */
  async function readArtifact(threadId: string, projectId: string, name: string) {
    try {
      const { hostId, dir } = await artifactDir(threadId, projectId);
      const path = join(dir, name);
      const file = await bb.sdk.files.read({ hostId, path });
      return { path, text: typeof file === "string" ? file : (file as { content?: string }).content ?? "" };
    } catch {
      return null;
    }
  }

  /** Runs the write, retrying while bb answers HTTP 409 (the thread's environment is still provisioning): 7 tries,
   * about 60 s of waits. Any other error, or the last 409, propagates. */
  async function retryWhileProvisioning<T>(write: () => Promise<T>) {
    for (const seconds of [1, 2, 4, 8, 15, 30]) {
      try {
        return await write();
      } catch (error) {
        // shortcut: the SDK's BbHttpError is not exported, so the message text is how we detect the 409; upgrade when it is.
        if (!/HTTP 409/.test(String(error))) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
    return write();
  }

  /** Best-effort: keeps the exact spawn prompt in the thread's own storage so it can re-read its brief after a compaction,
   * and as the brief.md Chief artifact, which cleanup never clears. The two copies run independently, each retried while
   * a new environment provisions; the artifact copy goes to the project's host without asking for the thread's storage
   * location. The brief is held in pending_briefs until both copies settle, so a plugin reload does not lose it.
   * Each write fails alone, DB failures only warn, and persistBrief never throws. */
  async function persistBrief(threadId: string, projectId: string, prompt: string) {
    try {
      db.prepare(`INSERT OR REPLACE INTO pending_briefs (thread_id, project_id, prompt, at) VALUES (?, ?, ?, ?)`).run(threadId, projectId, prompt, Date.now());
    } catch (error) {
      bb.log.warn(`Could not record ${threadId}'s pending brief: ${String(error)}`);
    }
    try {
      await Promise.all([
        retryWhileProvisioning(() => writeStorageFile(threadId, "brief.md", prompt))
          .catch((error) => bb.log.warn(`Could not write ${threadId}'s brief: ${String(error)}`)),
        // The host lookup lives in this branch so a slow lookup never delays the storage copy.
        ctx.projectHostId(projectId)
          .then((hostId) => retryWhileProvisioning(() => writeArtifact(threadId, projectId, "brief.md", prompt, hostId ?? undefined)))
          .catch((error) => bb.log.warn(`Could not write ${threadId}'s brief artifact: ${String(error)}`)),
      ]);
    } finally {
      if (!disposed) {
        try {
          db.prepare(`DELETE FROM pending_briefs WHERE thread_id=?`).run(threadId);
        } catch (error) {
          bb.log.warn(`Could not clear ${threadId}'s pending brief: ${String(error)}`);
        }
      }
    }
  }

  /** Replays briefs a reload interrupted; called once per plugin generation by the brief-replay service. Returns at once. */
  function resumeBriefs() {
    let rows: { thread_id: string; project_id: string; prompt: string }[];
    try {
      rows = db.prepare(`SELECT thread_id, project_id, prompt FROM pending_briefs`).all() as typeof rows;
    } catch (error) {
      bb.log.warn(`Could not read pending briefs: ${String(error)}`);
      return;
    }
    for (const row of rows) void persistBrief(row.thread_id, row.project_id, row.prompt);
  }
  return { persistBrief, resumeBriefs, readArtifact, writeArtifact, writePlan, writeStorageFile };
}

