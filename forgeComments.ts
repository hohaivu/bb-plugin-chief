// Comments Chief posts on a task's pull request or tracking issue so a person can follow it.
// Pure text helpers (parse, sanitize, compose) plus the gh/glab calls; the outbox that makes
// delivery crash-safe lives in server.ts. Nothing here reads a comment into an agent.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import { clip, clipMiddle } from "./text";

const execFileAsync = promisify(execFile);

const FORGE_COMMENT_TIMEOUT_MS = 30_000;
/** GitHub's comment limit is 65,536; this leaves room for the header, mention and marker. */
const BODY_BUDGET = 60_000;
const MAX_LIST_PAGES = 50;

export type ForgeTarget = { forge: "github" | "gitlab"; host: string; repo: string; kind: "pull" | "issue"; number: number };

/** Only full URLs: GitHub https://host/o/r/(pull|issues)/N, GitLab https://host/<group path>/-/(merge_requests|issues)/N. */
export function parseForgeTarget(url: string | null | undefined): ForgeTarget | null {
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
export const markerFor = (key: string) => `<!-- chief:${createHash("sha1").update(key).digest("hex").slice(0, 16)} -->`;

const fenceLines = (text: string) => text.split("\n").filter((line) => /^\s*```/.test(line)).length;

/** Header, summary lines, optional collapsed details, and the marker as the last line.
 * Every text argument must already be sanitized. */
export function composeComment(input: {
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
export function withMention(body: string, handle: string | null) {
  if (!handle || !/^[A-Za-z0-9_.-]+$/.test(handle)) return body;
  const at = body.lastIndexOf("\n\n<!-- chief:");
  return at < 0 ? body : `${body.slice(0, at)}\n\n@${handle}${body.slice(at)}`;
}

/** "permanent": no CLI, not logged in, or the target is gone: retrying cannot help. Anything else is transient. */
export function classify(error: unknown): "permanent" | "transient" {
  const failure = (error ?? {}) as { code?: unknown; stderr?: unknown; message?: unknown };
  if (failure.code === "ENOENT") return "permanent";
  const text = `${String(failure.stderr ?? "")} ${String(failure.message ?? error)}`;
  if (/rate limit|abuse|too many requests|\b429\b/i.test(text)) return "transient";
  return /\b40[134]\b|not logged in|authentication|bad credentials|gh auth login|glab auth login|no oauth token|no token/i.test(text) ? "permanent" : "transient";
}

export const errorText = (error: unknown) => clip(String((error as { stderr?: unknown })?.stderr || error).trim(), 300);

const options = (env: NodeJS.ProcessEnv) => ({ timeout: FORGE_COMMENT_TIMEOUT_MS, env, maxBuffer: 32 * 1024 * 1024 });
const notesPath = (target: ForgeTarget) => target.forge === "github"
  ? `repos/${target.repo}/issues/${target.number}/comments`
  : `projects/${encodeURIComponent(target.repo)}/${target.kind === "pull" ? "merge_requests" : "issues"}/${target.number}/notes`;

export async function postComment(target: ForgeTarget, body: string, env: NodeJS.ProcessEnv) {
  if (target.forge === "github") {
    await execFileAsync("gh", ["api", "--hostname", target.host, "--method", "POST", notesPath(target), "-f", `body=${body}`], options(env));
  } else {
    await execFileAsync("glab", ["api", "--hostname", target.host, "--method", "POST", notesPath(target), "--raw-field", `body=${body}`], options(env));
  }
}

/** Whether a comment holding this key's marker is already on the target. Throws when the list cannot be read. */
export async function hasMarker(target: ForgeTarget, key: string, env: NodeJS.ProcessEnv) {
  const marker = markerFor(key);
  if (target.forge === "github") {
    const { stdout } = await execFileAsync("gh", ["api", "--hostname", target.host, "--paginate", notesPath(target), "--jq", ".[].body"], options(env));
    return stdout.includes(marker);
  }
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const { stdout } = await execFileAsync("glab", ["api", "--hostname", target.host, `${notesPath(target)}?per_page=100&page=${page}`], options(env));
    const notes = JSON.parse(stdout) as { body?: string }[];
    if (notes.some((note) => note.body?.includes(marker))) return true;
    if (notes.length < 100) return false;
  }
  return false;
}

const handles = new Map<string, string>();
/** The @handle to mention: the configured one, else the CLI's logged-in user (cached per host). Null when neither is known. */
export async function ownerHandle(target: ForgeTarget, configured: string, env: NodeJS.ProcessEnv) {
  const set = configured.trim().replace(/^@/, "");
  if (set) return set;
  const cached = handles.get(target.host);
  if (cached) return cached;
  try {
    const login = target.forge === "github"
      ? (await execFileAsync("gh", ["api", "--hostname", target.host, "user", "--jq", ".login"], options(env))).stdout.trim()
      : (JSON.parse((await execFileAsync("glab", ["api", "--hostname", target.host, "user"], options(env))).stdout) as { username?: string }).username ?? "";
    if (!/^[A-Za-z0-9_.-]+$/.test(login)) return null;
    handles.set(target.host, login);
    return login;
  } catch {
    return null;
  }
}
