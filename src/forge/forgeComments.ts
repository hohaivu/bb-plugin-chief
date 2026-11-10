// Comments Chief posts on a task's pull request or tracking issue so a person can follow it.
// Owns the durable outbox (table, attempts, retry, marker scan, drain) and the gh/glab adapters.
// Never blocks or fails its caller: a comment is an extra copy of the local record. Nothing here reads a comment into an agent.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { clip, clipMiddle } from "../../text";

const execFileAsync = promisify(execFile);

const FORGE_COMMENT_TIMEOUT_MS = 30_000;
/** GitHub's comment limit is 65,536; this leaves room for the header, mention and marker. */
const BODY_BUDGET = 60_000;
const MAX_LIST_PAGES = 50;

export type ForgeTarget = { forge: "github" | "gitlab"; host: string; repo: string; kind: "pull" | "issue"; number: number };

/** Only full URLs: GitHub https://host/o/r/(pull|issues)/N, GitLab https://host/<group path>/-/(merge_requests|issues)/N. */
function parseForgeTarget(url: string | null | undefined): ForgeTarget | null {
  const github = url?.trim().match(/^https?:\/\/([^/\s]+)\/([^/\s]+\/[^/\s]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/);
  if (github) return { forge: "github", host: github[1]!, repo: github[2]!, kind: github[3] === "pull" ? "pull" : "issue", number: Number(github[4]) };
  const gitlab = url?.trim().match(/^https?:\/\/([^/\s]+)\/(.+?)\/-\/(merge_requests|issues)\/(\d+)(?:[/?#].*)?$/);
  if (gitlab) return { forge: "gitlab", host: gitlab[1]!, repo: gitlab[2]!, kind: gitlab[3] === "issues" ? "issue" : "pull", number: Number(gitlab[4]) };
  return null;
}

const PATH_CHARS = `[^\\s'"\`<>()\\[\\]|,;]`;
// An absolute local path, ~/…, a .bb/ path or a chief-gate-* temp dir.
const LOCAL_PATH = new RegExp(
  `(?<![\\w.:/-])(?:~|/(?:Users|home|tmp|private|var|root|opt|Volumes))(?:/${PATH_CHARS}*)+|\\.bb/${PATH_CHARS}*|chief-gate-[\\w.-]+(?:/${PATH_CHARS}*)*`, "g");

/** Text from an agent or a tool never carries a local path, a thread id, a bb command, a live @mention or a fake marker onto the forge. */
export function sanitizeForge(text: string) {
  return text
    // A file URL is a local path: drop the scheme so LOCAL_PATH reduces it to its basename and location.
    .replace(/\bfile:\/\/(?:localhost)?(?=\/)/gi, "")
    .replace(/`\s*(?:\$ )?bb\s[^`\n]*`/g, "[bb command]")
    .replace(/^[ \t]*(?:\$ )?bb\s.*$/gm, "[bb command]")
    .replace(LOCAL_PATH, (path) => {
      const trailing = path.match(/[.:!?]+$/)?.[0] ?? "";
      const bare = trailing ? path.slice(0, -trailing.length) : path;
      return `${basename(bare.replace(/\/+$/, "")) || "path"}${trailing}`;
    })
    .replace(/\bthr_[A-Za-z0-9]+/g, "[thread]")
    .replace(/@(?=[A-Za-z0-9_])/g, "@​")
    .replace(/<!--/g, "&lt;!--");
}

/** The hidden marker a comment ends with: a hash of the dedupe key, so no thread id reaches the forge. */
const markerFor = (key: string) => `<!-- chief:${createHash("sha1").update(key).digest("hex").slice(0, 16)} -->`;

const fenceLines = (text: string) => text.split("\n").filter((line) => /^\s*```/.test(line)).length;

/** Header, summary lines, optional collapsed details, and the marker as the last line.
 * Every text argument must already be sanitized. */
function composeComment(input: {
  key: string; title: string; round?: number; lines: string[]; details?: { summary: string; body: string };
}) {
  const head = `**Chief · ${input.title}**${input.round ? ` · round ${input.round}` : ""}`;
  const marker = markerFor(input.key);
  const summary = [head, ...input.lines].join("\n");
  let details = "";
  if (input.details?.body.trim()) {
    const fixed = 120 + input.details.summary.length + summary.length + marker.length;
    let body = clipMiddle(input.details.body.trim(), Math.max(1_000, BODY_BUDGET - fixed));
    if (fenceLines(body) % 2) body += "\n```";
    details = `\n\n<details><summary>${input.details.summary}</summary>\n\n${body}\n\n</details>`;
  }
  return `${summary}${details}\n\n${marker}`;
}

/** Puts the owner's @handle on its own line before the marker. A handle that is not a plain login is dropped. */
function withMention(body: string, handle: string | null) {
  if (!handle || !/^[A-Za-z0-9_.-]+$/.test(handle)) return body;
  const at = body.lastIndexOf("\n\n<!-- chief:");
  return at < 0 ? body : `${body.slice(0, at)}\n\n@${handle}${body.slice(at)}`;
}

/** "permanent": no CLI, not logged in, or the target is gone: retrying cannot help. Anything else is transient. */
function classify(error: unknown): "permanent" | "transient" {
  const failure = (error ?? {}) as { code?: unknown; stderr?: unknown; message?: unknown };
  if (failure.code === "ENOENT") return "permanent";
  const text = `${String(failure.stderr ?? "")} ${String(failure.message ?? error)}`;
  if (/rate limit|abuse|too many requests|\b429\b/i.test(text)) return "transient";
  return /\b40[134]\b|not logged in|authentication|bad credentials|gh auth login|glab auth login|no oauth token|no token/i.test(text) ? "permanent" : "transient";
}

const errorText = (error: unknown) => clip(String((error as { stderr?: unknown })?.stderr || error).trim(), 300);

const options = (env: NodeJS.ProcessEnv) => ({ timeout: FORGE_COMMENT_TIMEOUT_MS, env, maxBuffer: 32 * 1024 * 1024 });
const notesPath = (target: ForgeTarget) => target.forge === "github"
  ? `repos/${target.repo}/issues/${target.number}/comments`
  : `projects/${encodeURIComponent(target.repo)}/${target.kind === "pull" ? "merge_requests" : "issues"}/${target.number}/notes`;

// Comments to post on a task's pull request or tracking issue. A row is written with the state change it describes and posted off the tool-call path; attempts is persisted before each post, so a crash is read as "maybe posted" and the marker check runs first.
export const FORGE_COMMENTS_TABLE = `CREATE TABLE forge_comments (dedupe_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL, mention INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, posted_at INTEGER, gave_up_at INTEGER, created_at INTEGER NOT NULL)`;

export interface ForgeAdapter {
  post(target: ForgeTarget, body: string): Promise<void>;
  /** Whether a comment containing this exact marker text is on the target. Throws when the comment list cannot be read in full. */
  hasMarker(target: ForgeTarget, marker: string): Promise<boolean>;
  /** The CLI's logged-in user, not yet validated. */
  login(target: ForgeTarget): Promise<string>;
}

/** The two real adapters. Each call reads the environment fresh. The marker is searched verbatim: the outbox hashes the key once. */
export function cliAdapters(env: () => NodeJS.ProcessEnv): Record<ForgeTarget["forge"], ForgeAdapter> {
  return {
    github: {
      async post(target, body) {
        await execFileAsync("gh", ["api", "--hostname", target.host, "--method", "POST", notesPath(target), "-f", `body=${body}`], options(env()));
      },
      async hasMarker(target, marker) {
        const { stdout } = await execFileAsync("gh", ["api", "--hostname", target.host, "--paginate", notesPath(target), "--jq", ".[].body"], options(env()));
        return stdout.includes(marker);
      },
      async login(target) {
        return (await execFileAsync("gh", ["api", "--hostname", target.host, "user", "--jq", ".login"], options(env()))).stdout.trim();
      },
    },
    gitlab: {
      async post(target, body) {
        await execFileAsync("glab", ["api", "--hostname", target.host, "--method", "POST", notesPath(target), "--raw-field", `body=${body}`], options(env()));
      },
      async hasMarker(target, marker) {
        for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
          const { stdout } = await execFileAsync("glab", ["api", "--hostname", target.host, `${notesPath(target)}?per_page=100&page=${page}`], options(env()));
          const notes = JSON.parse(stdout) as { body?: string }[];
          if (notes.some((note) => note.body?.includes(marker))) return true;
          if (notes.length < 100) return false;
        }
        // An incomplete scan never proves the marker absent: the caller must not post on it.
        throw new Error(`Marker scan stopped after ${MAX_LIST_PAGES} pages of notes without reaching the end; not posting blind.`);
      },
      async login(target) {
        return (JSON.parse((await execFileAsync("glab", ["api", "--hostname", target.host, "user"], options(env()))).stdout) as { username?: string }).username ?? "";
      },
    },
  };
}

export type ForgeComment = { title: string; round?: number; lines: string[]; details?: { summary: string; body: string } };

interface ForgeCommentRow {
  dedupe_key: string; project_id: string; thread_id: string; target: string; body: string; mention: number; attempts: number;
}
const MAX_ATTEMPTS = 5;
/** A transient failure waits this long before the next try; the supervisor tick (30 s) is the retry clock. */
const RETRY_MS = 25_000;

export function createForgeComments(deps: {
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  adapters: Record<ForgeTarget["forge"], ForgeAdapter>;
  /** The configured forgeOwnerHandle setting, "" when unset. */
  ownerHandle: () => Promise<string>;
  /** Alert Chief once about a failed comment. The module contains its throws and rejections. */
  escalate: (threadId: string, alertKey: string, message: string) => Promise<unknown>;
  log: Pick<BbPluginApi["log"], "info" | "warn" | "error">;
}) {
  const { db, adapters, log } = deps;
  const tried = new Map<string, number>();
  const handles = new Map<string, string>();

  /** The owner's @handle: the configured one, else the CLI's logged-in user (cached per host). Null when neither is known. */
  async function mentionFor(target: ForgeTarget) {
    const set = (await deps.ownerHandle()).trim().replace(/^@/, "");
    if (set) return set;
    const cached = handles.get(target.host);
    if (cached) return cached;
    try {
      const login = await adapters[target.forge].login(target);
      if (!/^[A-Za-z0-9_.-]+$/.test(login)) return null;
      handles.set(target.host, login);
      return login;
    } catch {
      return null;
    }
  }

  /** Alerts Chief about a failed comment; a throw or rejection from the alert is logged, never raised. */
  const escalate = (threadId: string, key: string, message: string) =>
    Promise.resolve().then(() => deps.escalate(threadId, `forge-comment:${key}`, message))
      .catch((error) => log.error(`${message} The Chief alert also failed: ${String(error)}`));

  /** One attempt for one row. attempts is persisted before any network call, so a crash mid-post reads as "maybe posted"
   * on the next try, which looks for the marker before posting again. */
  async function attempt(comment: ForgeCommentRow) {
    const key = comment.dedupe_key;
    const prior = comment.attempts;
    db.prepare(`UPDATE forge_comments SET attempts=attempts+1 WHERE dedupe_key=?`).run(key);
    tried.set(key, Date.now());
    try {
      const target = parseForgeTarget(comment.target);
      if (!target) throw Object.assign(new Error("the target is not a pull request or issue URL"), { code: "ENOENT" });
      const adapter = adapters[target.forge];
      if (!(prior > 0 && await adapter.hasMarker(target, markerFor(key)))) {
        await adapter.post(target, comment.mention ? withMention(comment.body, await mentionFor(target)) : comment.body);
      }
      db.prepare(`UPDATE forge_comments SET posted_at=?, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
      tried.delete(key);
    } catch (error) {
      const reason = errorText(error);
      const permanent = classify(error) === "permanent";
      const exhausted = !permanent && prior + 1 >= MAX_ATTEMPTS;
      db.prepare(`UPDATE forge_comments SET last_error=?, gave_up_at=? WHERE dedupe_key=?`).run(reason, permanent || exhausted ? Date.now() : null, key);
      if (permanent) log.info(`Forge comment ${key.split(":")[0]} on ${comment.target} not posted (the forge CLI is missing, not logged in, or the target is gone): ${reason}`);
      if (permanent || exhausted) tried.delete(key);
      if (exhausted) await escalate(comment.thread_id, key, `Could not post the ${key.split(":")[0]} comment to ${comment.target} after ${MAX_ATTEMPTS} attempts: ${reason}. The local record is intact.`);
    }
  }

  async function pass() {
    const now = Date.now();
    const pending = db.prepare(`SELECT * FROM forge_comments WHERE posted_at IS NULL AND gave_up_at IS NULL ORDER BY created_at LIMIT 20`).all() as ForgeCommentRow[];
    for (const comment of pending) {
      if (now - (tried.get(comment.dedupe_key) ?? 0) < RETRY_MS) continue;
      await attempt(comment);
    }
  }

  let draining: Promise<void> | null = null;
  let again = false;
  /** Single-flight: an enqueue during a drain queues exactly one more pass. Callers never await it; it never rejects. */
  function drain() {
    if (draining) { again = true; return draining; }
    draining = (async () => {
      do {
        again = false;
        await pass();
      } while (again);
    })().catch((error) => log.warn(`Forge comment drain failed; the supervisor tick retries: ${String(error)}`)).finally(() => { draining = null; });
    return draining;
  }

  return {
    drain,
    /** Queues a comment for the target's pull request or issue; the post happens off the caller's path.
     * Never throws and never blocks: a forge comment is an extra copy of the local record, so the state change
     * that triggered it always completes. A target that is no forge URL means no forge to post to: logged, not an error.
     * Safe inside store.batch: the drain starts after the batch commits. */
    enqueue(input: { key: string; row: { project_id: string; thread_id: string }; target: string | null | undefined; comment: ForgeComment; mention?: boolean }) {
      try {
        if (!parseForgeTarget(input.target)) {
          log.info(`No forge comment for ${input.key}: ${input.target ? "its target is not a full pull request or issue URL" : "there is no pull request or issue to post on"}.`);
          return false;
        }
        db.prepare(`INSERT OR IGNORE INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(input.key, input.row.project_id, input.row.thread_id, input.target, composeComment({ key: input.key, ...input.comment }), input.mention ? 1 : 0, Date.now());
        queueMicrotask(() => { void drain(); });
        return true;
      } catch (error) {
        const message = `Could not queue the forge comment ${input.key.split(":")[0]} for ${input.target}: ${errorText(error)}. The local record is intact.`;
        log.warn(message);
        // Deferred so a failure inside store.batch does not write the alert into the transaction that may roll back.
        queueMicrotask(() => { void escalate(input.row.thread_id, input.key, message); });
        return false;
      }
    },
  };
}
