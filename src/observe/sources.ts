import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { clip } from "../core/text";
import { type ManagedRow } from "../types";
import { bounded } from "../runtime/exec";
import type { Ctx } from "../runtime/context";
import { agyDbPath, failedStatus, readAgySteps, RECENT_STEPS } from "./agyHistory";
import { secretsOf } from "./sentry";
import { normalize, scrub } from "./scrub";

/** Read-only evidence adapters for the daily report. Nothing here writes, renames or deletes: files are only stat-ed and streamed, SQLite is opened only through readAgySteps (-readonly, mode=ro). */

export type SectionStatus = "ok" | "skipped" | "unavailable" | "error";
export interface Item { at: number; threadId?: string; kind: string; count?: number; text: string }
export interface Section { name: string; status: SectionStatus; note?: string; items: Item[] }
export interface SentryIssue { title: string; count: number; level: string; firstSeen: string; lastSeen: string; permalink: string; shortId: string }

/** What one adapter sees. `clean` scrubs with the configured secrets and clips to an excerpt. */
export interface Env {
  ctx: Ctx;
  since: number;
  until: number;
  threads: ManagedRow[];
  secrets: string[];
  clean: (text: string) => string;
  providerId: (threadId: string) => Promise<string | null>;
  dataDir: () => Promise<string | null>;
}
export type Adapter = (env: Env) => Promise<{ status: SectionStatus; note?: string; items: Item[] }>;

export const MAX_ITEMS = 200;
export const EXCERPT_CHARS = 300;
const ADAPTER_DEADLINE_MS = 120_000;
const MAX_RAW = 5_000;
/** Kinds that describe activity, not a failure: a pattern of these is no problem. */
export const ACTIVITY_KINDS = new Set(["tokens", "steps"]);

type Raw = { at: number; threadId?: string; kind: string; count?: number; text: string; key?: string };

/** Scrubs, clips, groups equal problems (per thread and kind, by normalized text) with a count, and keeps the 200 most frequent. */
function finish(env: Env, raws: Raw[], limit = MAX_ITEMS): Item[] {
  const groups = new Map<string, Item>();
  for (const raw of raws) {
    const text = env.clean(raw.text);
    const key = `${raw.threadId ?? ""}\u0000${raw.kind}\u0000${raw.key ?? normalize(text)}`;
    const found = groups.get(key);
    if (found) {
      found.count = (found.count ?? 1) + (raw.count ?? 1);
      found.at = Math.max(found.at, raw.at);
    } else groups.set(key, { at: raw.at, ...(raw.threadId ? { threadId: raw.threadId } : {}), kind: raw.kind, count: raw.count ?? 1, text });
  }
  return [...groups.values()].sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || b.at - a.at).slice(0, limit);
}

/** One (thread, kind): the total count, with the first 3 occurrences as excerpts whose counts add up to it. */
function excerpts(threadId: string, kind: string, list: { at: number; text: string }[]): Raw[] {
  const shown = list.slice(0, 3);
  return shown.map((entry, index) => ({ ...entry, threadId, kind, count: index === 0 ? list.length - shown.length + 1 : 1 }));
}

const toMs = (value: unknown): number | null => {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? null : parsed;
};

/** Streams a JSONL file line by line; `visit` returns false to stop. Lines that are not JSON are skipped. */
async function eachJsonLine(file: string, visit: (obj: Record<string, any>, raw: string) => boolean | void) {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let obj: Record<string, any>;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && typeof obj === "object" && visit(obj, line) === false) break;
    }
  } finally {
    lines.close();
  }
}

export const textOfContent = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").filter(Boolean).join(" ")
  : content == null ? "" : JSON.stringify(content);

const chiefEvents: Adapter = async (env) => {
  const rows = env.ctx.db.prepare(`SELECT at, thread_id, kind, detail FROM chief_events WHERE at >= ? AND at < ? ORDER BY at DESC LIMIT ?`)
    .all(env.since, env.until, MAX_RAW) as { at: number; thread_id: string | null; kind: string; detail: string | null }[];
  return { status: "ok", items: finish(env, rows.map((row) => ({ at: row.at, ...(row.thread_id ? { threadId: row.thread_id } : {}), kind: row.kind, text: row.detail ?? row.kind }))) };
};

const THREAD_EVENT_TYPES = ["provider/error", "system/error", "provider/warning", "system/provider-turn-watchdog", "thread/compacted"] as const;
export type LooseEvent = { type: string; seq: number | string; createdAt: number; data: Record<string, any> };

export const EVENT_PAGE = 100;
/** The one way the report and the retro read a thread's events: a single bounded events.list call. */
export const listEvents = (bb: Ctx["bb"], threadId: string, types: readonly string[], query: Record<string, string> = {}) =>
  bounded(() => bb.sdk.threads.events.list({ threadId, types: [...types], ...query } as never), 15_000) as unknown as Promise<LooseEvent[]>;

/** Newest first: the events in [since, until), at most `max`, scanning at most `pages` pages and stopping at the first event before `since`. Throws when a call fails. */
export async function recentEvents(bb: Ctx["bb"], threadId: string, types: readonly string[], window: { since: number; until?: number; max?: number; pages?: number }) {
  const { since, until = Infinity, max = Infinity, pages = Infinity } = window;
  const found: LooseEvent[] = [];
  let beforeSeq: string | undefined;
  for (let page = 0; page < pages && found.length < max; page++) {
    const batch = await listEvents(bb, threadId, types, { order: "desc", limit: String(EVENT_PAGE), ...(beforeSeq ? { beforeSeq } : {}) });
    for (const event of batch) {
      if (event.createdAt < since) return found;
      if (event.createdAt < until && found.length < max) found.push(event);
    }
    if (batch.length < EVENT_PAGE) break;
    beforeSeq = String(batch.at(-1)!.seq);
  }
  return found;
}

/** The provider's own id for a thread (its newest thread/identity event), or null. Throws when the call fails. */
export async function providerThreadId(bb: Ctx["bb"], threadId: string): Promise<string | null> {
  const [identity] = await listEvents(bb, threadId, ["thread/identity"], { order: "desc", limit: "1" });
  return identity?.data.providerThreadId ?? null;
}

const bbThreads: Adapter = async (env) => {
  const { bb } = env.ctx;
  const raws: Raw[] = [];
  let failed = 0;
  for (let start = 0; start < env.threads.length; start += 5) {
    await Promise.all(env.threads.slice(start, start + 5).map(async (thread) => {
      try {
        // 300 events at most per thread: 100 of the failure types, 200 of the item events (most of them are not failures).
        const window = { since: env.since, until: env.until };
        const [problems, items] = await Promise.all([recentEvents(bb, thread.thread_id, THREAD_EVENT_TYPES, { ...window, max: 100 }), recentEvents(bb, thread.thread_id, ["item/completed"], { ...window, max: 200 })]);
        const byKind = new Map<string, { at: number; text: string }[]>();
        const add = (kind: string, at: number, text: string) => byKind.set(kind, [...(byKind.get(kind) ?? []), { at, text }]);
        for (const event of problems) {
          const data = event.data;
          if (event.type === "thread/compacted") add("compaction", event.createdAt, "context compacted");
          else if (event.type === "provider/error") {
            const info = data.errorInfo;
            add("provider_error", event.createdAt, [info?.category, info?.httpStatusCode, data.message, data.detail].filter(Boolean).join(" "));
          } else if (event.type === "system/error") add("system_error", event.createdAt, [data.message, data.detail].filter(Boolean).join(" "));
          else if (event.type === "provider/warning") add("provider_warning", event.createdAt, String(data.message ?? "provider warning"));
          else add("watchdog", event.createdAt, String(data.message ?? data.reason ?? data.kind ?? "provider turn watchdog"));
        }
        for (const event of items) {
          const item = event.data.item;
          if (item?.type !== "toolCall" || item.status === "completed") continue;
          const result = item.result == null ? "[output expired]" : textOfContent(item.result);
          add(`tool_${item.status}`, event.createdAt, `${item.tool}: ${result}`);
        }
        for (const [kind, list] of byKind) raws.push(...excerpts(thread.thread_id, kind, list));
      } catch {
        failed += 1;
      }
    }));
  }
  return { status: "ok", ...(failed ? { note: `${failed} of ${env.threads.length} threads could not be read` } : {}), items: finish(env, raws) };
};

const bbLogs: Adapter = async (env) => {
  const dir = await env.dataDir();
  if (!dir) return { status: "unavailable", note: "the BB data directory is unknown", items: [] };
  const raws: Raw[] = [];
  const noted: string[] = [];
  async function scan(root: string, wanted: (name: string) => boolean, line: (obj: Record<string, any>, raw: string, name: string) => Raw | null) {
    let names: string[];
    try { names = (await readdir(root)).filter(wanted); } catch { noted.push(`${root} not on this machine`); return; }
    for (const name of names) {
      const file = join(root, name);
      // A file last written before the window holds nothing for it: never opened.
      const mtime = (await stat(file)).mtimeMs;
      if (mtime < env.since) continue;
      await eachJsonLine(file, (obj, raw) => {
        const found = line(obj, raw, name);
        // A line with no readable time is dated by its file's last write.
        if (found && (found.at ||= mtime) >= env.since && found.at < env.until) raws.push(found);
        return raws.length < MAX_RAW;
      });
    }
  }
  const pino = (kind: string) => (obj: Record<string, any>, _raw: string, name: string): Raw | null => {
    const message = String(obj.msg ?? obj.message ?? "");
    const level = Number(obj.level);
    if (!(level >= 50 || (level >= 40 && message.includes("[plugin:chief]")))) return null;
    const detail = obj.err?.message ?? obj.error?.message ?? "";
    return { at: toMs(obj.time) ?? 0, kind: level >= 50 ? kind : `${kind}_warn`, text: `${name}: ${message}${detail ? ` ${detail}` : ""}` };
  };
  await scan(join(dir, "logs"), (name) => /^server.*\.log$/.test(name) || /^host-daemon.*\.log$/.test(name), (obj, raw, name) => pino(name.startsWith("server") ? "server_log" : "daemon_log")(obj, raw, name));
  await scan(join(dir, "logs"), (name) => name === "cli-errors.jsonl", (obj, raw) => ({
    at: toMs(obj.ts ?? obj.time ?? obj.at ?? obj.timestamp) ?? 0, kind: "cli_error", text: String(obj.message ?? obj.error ?? obj.msg ?? raw),
  }));
  await scan(join(dir, "plugins", "chief", "logs"), (name) => name.startsWith("plugin.log"), (obj) =>
    obj.level === "warn" || obj.level === "error" ? { at: toMs(obj.ts) ?? 0, kind: "plugin_log", text: String(obj.message ?? "") } : null);
  return { status: "ok", ...(noted.length ? { note: noted.join("; ") } : {}), items: finish(env, raws) };
};

type Parsed = { raws: Raw[]; problem?: { status: "skipped" | "unavailable"; note: string } };

/** A provider's own history file for each thread in scope: a thread whose file is not here is counted, not guessed at. */
function providerAdapter(label: string, locate: (env: Env, providerThreadId: string) => Promise<string | null>, parse: (env: Env, thread: ManagedRow, file: string) => Promise<Parsed>): Adapter {
  return async (env) => {
    if (!env.threads.length) return { status: "ok", note: "no threads were active in the window", items: [] };
    const raws: Raw[] = [];
    const missing: string[] = [];
    const problems: { status: "skipped" | "unavailable"; note: string }[] = [];
    let read = 0;
    for (const thread of env.threads) {
      const id = await env.providerId(thread.thread_id);
      const file = id ? await locate(env, id) : null;
      if (!file) { missing.push(thread.thread_id); continue; }
      // Not touched since the window opened: nothing in it, and the file stays unopened.
      if ((await stat(file)).mtimeMs < env.since) { read += 1; continue; }
      const parsed = await parse(env, thread, file);
      if (parsed.problem) problems.push(parsed.problem);
      else { read += 1; raws.push(...parsed.raws); }
    }
    const notes = [
      ...(missing.length ? [`not on this machine for ${missing.length} of ${env.threads.length} threads (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""})`] : []),
      ...[...new Set(problems.map((problem) => problem.note))],
    ];
    const status: SectionStatus = read > 0 ? "ok" : problems.some((problem) => problem.status === "skipped") ? "skipped" : "unavailable";
    return { status, ...(notes.length ? { note: `${label}: ${notes.join("; ")}` } : {}), items: finish(env, raws) };
  };
}

/** Error excerpts, compactions and token totals of one JSONL session; the two formats differ only in how an entry is read. */
async function sessionItems(env: Env, thread: ManagedRow, file: string, read: (obj: Record<string, any>) => { at: number | null; error?: string; compaction?: boolean; usage?: { id?: string; input: number; output: number } }): Promise<Parsed> {
  const errors: { at: number; text: string }[] = [];
  const seen = new Set<string>();
  let compactions = 0, input = 0, output = 0, lastAt = 0;
  await eachJsonLine(file, (obj) => {
    const entry = read(obj);
    if (entry.at === null || entry.at < env.since || entry.at >= env.until) return;
    lastAt = Math.max(lastAt, entry.at);
    if (entry.error !== undefined) errors.push({ at: entry.at, text: entry.error || "(no error text)" });
    if (entry.compaction) compactions += 1;
    // A streamed message is written once per content block with the same usage: count each message once.
    if (entry.usage && !(entry.usage.id && seen.has(entry.usage.id))) {
      if (entry.usage.id) seen.add(entry.usage.id);
      input += entry.usage.input;
      output += entry.usage.output;
    }
  });
  errors.reverse(); // newest first
  const raws = excerpts(thread.thread_id, "tool_error", errors);
  if (compactions) raws.push({ at: lastAt, threadId: thread.thread_id, kind: "compaction", count: compactions, text: "context compacted" });
  if (input || output) raws.push({ at: lastAt, threadId: thread.thread_id, kind: "tokens", text: `tokens in=${input} out=${output}`, key: `tokens:${input}:${output}` });
  return { raws };
}

const claudeCode = providerAdapter("Claude Code",
  async (_env, id) => {
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
    for (const dir of await readdir(projects).catch(() => [] as string[])) {
      const file = join(projects, dir, `${id}.jsonl`);
      if (await stat(file).then(() => true, () => false)) return file;
    }
    return null;
  },
  (env, thread, file) => sessionItems(env, thread, file, (obj) => {
    const message = obj.message;
    const blocks: unknown[] = Array.isArray(message?.content) ? message.content : [];
    const failure = blocks.find((block: any) => block?.type === "tool_result" && block.is_error);
    return {
      at: toMs(obj.timestamp),
      ...(failure ? { error: textOfContent((failure as any).content) } : {}),
      compaction: obj.type === "system" && obj.subtype === "compact_boundary",
      ...(message?.usage ? { usage: { id: message.id, input: Number(message.usage.input_tokens) || 0, output: Number(message.usage.output_tokens) || 0 } } : {}),
    };
  }));

const pi = providerAdapter("pi",
  async (env, id) => {
    const dir = await env.dataDir();
    const file = dir ? join(dir, "pi-bridge-sessions", `${id}.jsonl`) : null;
    return file && await stat(file).then(() => true, () => false) ? file : null;
  },
  (env, thread, file) => sessionItems(env, thread, file, (obj) => {
    const message = obj.message ?? obj;
    const usage = message.role === "assistant" ? message.usage : undefined;
    return {
      at: toMs(obj.timestamp ?? message.timestamp),
      ...(message.role === "toolResult" && message.isError ? { error: textOfContent(message.content) } : {}),
      compaction: obj.type === "compaction",
      ...(usage ? { usage: { id: message.id ?? obj.id, input: Number(usage.input ?? usage.input_tokens) || 0, output: Number(usage.output ?? usage.output_tokens) || 0 } } : {}),
    };
  }));

const agy = providerAdapter("agy",
  async (_env, id) => {
    const file = agyDbPath(id);
    return await stat(file).then(() => true, () => false) ? file : null;
  },
  async (_env, thread, file): Promise<Parsed> => {
    const history = await readAgySteps(file, RECENT_STEPS, true);
    if (history.status === "skipped" || history.status === "unavailable") return { raws: [], problem: { status: history.status, note: history.note } };
    if (history.status === "missing") return { raws: [], problem: { status: "unavailable", note: history.note } };
    const failed = history.steps.filter((step) => failedStatus(step.status));
    const at = Date.now();
    const errors = failed.reverse().map((step) => ({ at, text: `step_type ${step.stepType}: ${step.error ?? "(no readable error text)"}` }));
    // Steps carry no timestamp: the file's mtime gate is the only window, so the counts cover the newest steps.
    return { raws: [{ at, threadId: thread.thread_id, kind: "steps", count: history.steps.length, text: `agy steps (newest ${RECENT_STEPS}, not time-filtered)`, key: "steps" }, ...excerpts(thread.thread_id, "agy_error", errors)] };
  });

/** Unresolved Sentry issues for a query, or null when the token, org or project setting is unset (then nothing is fetched). */
async function fetchIssues(ctx: Ctx, query: string): Promise<SentryIssue[] | null> {
  const values = await ctx.settings.get();
  const { sentryAuthToken: token, sentryOrg: org, sentryProject: project } = values;
  if (!token || !org || !project) return null;
  const base = (values.sentryApiUrl || "https://sentry.io").replace(/\/+$/, "");
  const url = `${base}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?${new URLSearchParams({ query, sort: "date", limit: "50" })}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Sentry API HTTP ${response.status}`);
  const issues = (await response.json()) as Record<string, unknown>[];
  return issues.map((issue) => ({
    title: String(issue.title ?? ""), count: Number(issue.count) || 0, level: String(issue.level ?? ""),
    firstSeen: String(issue.firstSeen ?? ""), lastSeen: String(issue.lastSeen ?? ""), permalink: String(issue.permalink ?? ""), shortId: String(issue.shortId ?? ""),
  }));
}

/** Unresolved issues seen in the last `days` days that carry tag=value, or null when the Sentry settings are unset. The retro reads it. */
export const sentryIssuesForTag = (ctx: Ctx, tag: string, value: string, days: number) =>
  fetchIssues(ctx, `is:unresolved ${tag}:"${value.replace(/"/g, "")}" lastSeen:-${Math.max(1, Math.floor(days))}d`);

const sentry: Adapter = async (env) => {
  const issues = await fetchIssues(env.ctx, "is:unresolved lastSeen:-24h");
  if (!issues) return { status: "skipped", note: "the Sentry token, organization and project settings are not all set", items: [] };
  const raws = issues.map((issue): Raw => ({
    at: toMs(issue.lastSeen) ?? env.until, kind: (toMs(issue.firstSeen) ?? 0) >= env.since ? "new" : "recurring", count: issue.count,
    text: `${issue.shortId} [${issue.level}] ${issue.title} ${issue.permalink}`.trim(), key: issue.shortId || issue.title,
  }));
  return { status: "ok", items: finish(env, raws) };
};

export const ADAPTERS: Record<string, Adapter> = { chiefEvents, bbThreads, bbLogs, claudeCode, pi, agy, sentry };

/** The Sentry DSN, its public key and the read token: what no report line may hold. */
export const configuredSecrets = async (ctx: Ctx): Promise<string[]> => secretsOf(await ctx.settings.get().catch(() => ({})));

/** Runs every adapter on its own: a throw (or a 2-minute overrun) makes that one section "error" and never touches the others. */
export async function collectSources(ctx: Ctx, since: number, until: number, adapters: Record<string, Adapter> = ADAPTERS): Promise<Section[]> {
  const secrets = await configuredSecrets(ctx);
  const clean = (text: string) => clip(scrub(text, secrets), EXCERPT_CHARS);
  const identities = new Map<string, Promise<string | null>>();
  const env: Env = {
    ctx, since, until, secrets, clean,
    threads: ctx.store.all().filter((row) => row.updated_at >= since),
    providerId: (threadId) => {
      if (!identities.has(threadId)) {
        identities.set(threadId, providerThreadId(ctx.bb, threadId).catch(() => null));
      }
      return identities.get(threadId)!;
    },
    dataDir: async () => {
      const hostId = (await ctx.bb.sdk.system.config()).primaryHostId;
      if (!hostId) return null;
      if (ctx.state.dataDirs.get(hostId)) return ctx.state.dataDirs.get(hostId)!;
      const root = (await ctx.bb.sdk.hosts.get({ hostId })).threadStorageRootPath;
      return root ? dirname(root) : null;
    },
  };
  return Promise.all(Object.entries(adapters).map(async ([name, adapter]): Promise<Section> => {
    try {
      const section = await bounded(() => adapter(env), ADAPTER_DEADLINE_MS);
      return { name, ...section, ...(section.note ? { note: clean(section.note) } : {}), items: section.items.slice(0, MAX_ITEMS) };
    } catch (error) {
      return { name, status: "error", note: clean(String((error as Error)?.message ?? error).replace(/\s+/g, " ")), items: [] };
    }
  }));
}
