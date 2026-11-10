import { type ManagedRow } from "../types";
import { type ThreadInsert } from "../../threadStore";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Ctx } from "./context";

  export type ThreadInput = ThreadInsert<ManagedRow["role"], ManagedRow["state"]>;

export function createArtifacts(ctx: Ctx) {
  const { bb, db } = ctx;
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
    const location = await bb.sdk.threads.storageLocation({ threadId });
    const hostId = onHost ?? location.hostId, storageRootPath = location.storageRootPath;
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
        return { hostId, dir: storageRootPath };
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

  /** Atomic: the content lands under a temp name and is moved into place, so a failed
   * write never leaves a partial file under the final name. */
  async function atomicWrite(hostId: string, path: string, content: string) {
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      await bb.sdk.files.write({ hostId, path: tmp, content, createParents: true });
      await bb.sdk.files.move({ hostId, sourcePath: tmp, destinationPath: path });
    } catch (error) {
      await bb.sdk.files.remove({ hostId, path: tmp }).catch(() => undefined);
      throw error;
    }
    return path;
  }

  /** Best-effort: keeps the exact spawn prompt in the thread's own storage so it can re-read its brief after a compaction. Never throws. */
  async function persistBrief(threadId: string, prompt: string) {
    await writeStorageFile(threadId, "brief.md", prompt).catch((error) => bb.log.warn(`Could not write ${threadId}'s brief: ${String(error)}`));
  }
  return { persistBrief, writeArtifact, writePlan, writeStorageFile };
}

