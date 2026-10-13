/**
 * Built-in Backlog.md board module. Opt-in (`backlogEnabled`); server.ts only wires it in.
 *
 * The Backlog.md file format, discovery, ordering and `patchTask` code below is adapted from
 * https://github.com/StreamlinedStartup/bb-plugin-backlog (commit 7f5235e), MIT License,
 * Copyright (c) 2026 StreamlinedStartup. The full MIT permission notice is reproduced in
 * LICENSE-bb-plugin-backlog. Trimmed to what Chief uses; the module logic after the
 * "Chief module" marker is Chief's own.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { posix as path } from "node:path";
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from "yaml";
import { z } from "zod";

// ---- model (adapted from bb-plugin-backlog src/model.ts) ----
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);
export type FieldValue = z.infer<typeof valueSchema>;
export const editSchema = z.object({ kind: z.enum(["field", "section"]), key: z.string().max(100), before: valueSchema, value: valueSchema });
export type Edit = z.infer<typeof editSchema>;
const linkSchema = z.object({ threadId: z.string(), role: z.string(), title: z.string(), state: z.string(), prUrl: z.string().nullable() });
export type BacklogLink = z.infer<typeof linkSchema>;
export const taskSchema = z.object({
  path: z.string(), revision: z.string(), storage: z.enum(["active", "completed", "archived"]),
  id: z.string(), title: z.string(), status: z.string(), ordinal: z.number().nullable(),
  fields: z.record(z.string(), z.unknown()), body: z.string(),
  sections: z.record(z.string(), z.string()), errors: z.array(z.string()),
  progress: z.object({ done: z.number(), total: z.number() }),
});
export type Task = z.infer<typeof taskSchema>;
const boardTaskSchema = taskSchema.extend({ after: z.string().nullable(), links: z.array(linkSchema) });
export type BoardTask = z.infer<typeof boardTaskSchema>;
const boardSchema = z.object({
  enabled: z.boolean(), kind: z.enum(["off", "missing", "ambiguous", "ready"]),
  projectId: z.string(), folder: z.string().nullable(), message: z.string(), candidates: z.array(z.string()),
  statuses: z.array(z.string()), choices: z.record(z.string(), z.array(z.string())),
  warnings: z.array(z.string()), tasks: z.array(boardTaskSchema),
});
export type BacklogBoard = z.infer<typeof boardSchema>;

// ---- ordering (adapted from src/ordering.ts) ----
function compareTasks(a: Task, b: Task): number {
  return (a.ordinal ?? Number.MAX_VALUE) - (b.ordinal ?? Number.MAX_VALUE) || a.id.localeCompare(b.id, undefined, { numeric: true }) || a.path.localeCompare(b.path);
}
/** A single-file fractional order avoids partially committed multi-file rewrites. */
function insertionOrdinal(tasks: Task[], movingPath: string, status: string, beforePath: string | null): number {
  const lane = tasks.filter(t => t.path !== movingPath && t.status === status).sort(compareTasks);
  const index = beforePath === null ? lane.length : lane.findIndex(t => t.path === beforePath);
  if (index < 0) throw new Error("The target card moved. Refresh the board and try again.");
  const previous = lane[index - 1];
  const next = lane[index];
  // Unordered records sort after ordered records. Assign a finite position before
  // them, but refuse an insertion between indistinguishable missing/duplicate keys.
  if (previous && previous.ordinal === null) throw new Error("These tasks have no ordinal values. Place the card before the first unordered task to establish its order.");
  const low = previous?.ordinal ?? 0;
  const high = next?.ordinal ?? null;
  const value = high === null ? low + 1024 : previous ? low + (high - low) / 2 : high - 1024;
  if (!Number.isFinite(value) || (previous && value <= low) || (high !== null && value >= high)) throw new Error("There is no numeric ordering space between these cards. Move one to the start of the lane first.");
  return value;
}

// ---- task format (adapted from src/task-format.ts; the markdownExcerpt/splitFrontmatter helpers are dropped) ----
type Meta = Pick<Task, "path" | "revision" | "storage">;
type Span = { start: number; end: number; value: string };
const fieldLabels: Record<string, string> = {
 title: "Title", status: "Status", type: "Type", priority: "Priority", assignee: "Assignees", reporter: "Reporter", labels: "Labels", milestone: "Milestone", due_date: "Due date", project: "Project classification", dependencies: "Dependencies", references: "References", documentation: "Documentation", modified_files: "Modified files", ordinal: "Order", chief_after: "Wait condition",
};
const listFields = new Set(["assignee", "labels", "dependencies", "references", "documentation", "modified_files"]);
const sectionDefinitions: Record<string, { title: string; marker: string }> = {
 description: { title: "Description", marker: "SECTION:DESCRIPTION" },
 "acceptance criteria": { title: "Acceptance Criteria", marker: "AC" },
 "definition of done": { title: "Definition of Done", marker: "DOD" },
 "implementation plan": { title: "Implementation Plan", marker: "SECTION:PLAN" },
 "implementation notes": { title: "Implementation Notes", marker: "SECTION:NOTES" },
 "final summary": { title: "Final Summary", marker: "SECTION:FINAL_SUMMARY" },
};
const FRONTMATTER = /^(?:\uFEFF)?---[ \t]*(\r?\n)([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;
function frontmatter(raw: string) {
 const match = FRONTMATTER.exec(raw);
 if (!match || match.index !== 0) throw new Error("Task is missing a YAML frontmatter block.");
 const start = raw.indexOf("\n") + 1;
 const text = match[2];
 const doc = parseDocument(text, { uniqueKeys: true, keepSourceTokens: true });
 if (doc.errors.length) throw new Error(`Malformed YAML: ${doc.errors.map(e => e.message).join("; ")}`);
 if (!isMap(doc.contents)) throw new Error("Task frontmatter must be a mapping.");
 const data = doc.toJS({ maxAliasCount: 50 }) as Record<string, unknown>;
 return { start, end: match[0].length, text, doc, data, newline: match[1] };
}
function validateField(key: string, value: FieldValue) {
 if (!(key in fieldLabels)) throw new Error(`Field ${key} is read-only.`);
 if (key === "ordinal") {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Order must be a finite number.");
 } else if (listFields.has(key)) {
  if (value !== null && (!Array.isArray(value) || value.some(v => typeof v !== "string" || v.includes("\n")))) throw new Error(`${fieldLabels[key]} must be a list of strings.`);
 } else if (value !== null && typeof value !== "string") throw new Error(`${fieldLabels[key]} must be text.`);
 if (["title", "status"].includes(key) && (typeof value !== "string" || !value.trim())) throw new Error(`${fieldLabels[key]} cannot be empty.`);
 if (key === "due_date" && value && !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(String(value))) throw new Error("Due date must use YYYY-MM-DD or YYYY-MM-DD HH:mm.");
}
function bodySections(body: string) {
 const spans: Record<string, Span> = {};
 const errors: string[] = [];
 const lines: Array<{ text: string; start: number; end: number }> = [];
 const lineRe = /[^\n]*(?:\n|$)/g;
 let fence: { char: string; length: number } | null = null;
 for (const m of body.matchAll(lineRe)) {
  if (!m[0]) continue;
  const text = m[0].replace(/\r?\n$/, "");
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(text);
  if (match) {
   if (!fence) fence = { char: match[1][0], length: match[1].length };
   else if (match[1][0] === fence.char && match[1].length >= fence.length) fence = null;
   continue;
  }
  if (!fence) lines.push({ text, start: m.index!, end: m.index! + m[0].length });
 }
 const markers = lines.flatMap(line => {
  const m = /^<!-- (SECTION:[A-Z][A-Z0-9_]*|AC|DOD|COMMENTS|COMMENT):(BEGIN|END) -->[\t ]*$/.exec(line.text);
  return m ? [{ ...line, marker: m[1], kind: m[2] }] : [];
 });
 const ranges: Array<{ marker: string; start: number; end: number; innerStart: number; innerEnd: number }> = [];
 const stack: typeof markers = [];
 for (const marker of markers) {
  if (marker.kind === "BEGIN") stack.push(marker);
  else {
   const open = stack.pop();
   if (!open || open.marker !== marker.marker) { errors.push(`Ambiguous section marker ${marker.marker}.`); continue; }
   ranges.push({ marker: marker.marker, start: open.start, end: marker.end, innerStart: open.end, innerEnd: marker.start });
  }
 }
 if (stack.length) errors.push("A structured section has no END marker.");
 const add = (key: string, start: number, end: number) => {
  if (spans[key]) { errors.push(`Ambiguous duplicate section: ${key}.`); return; }
  const raw = body.slice(start, end);
  const leading = raw.match(/^(?:[ \t]*\r?\n)*/)?.[0].length ?? 0;
  const trailing = raw.match(/(?:\r?\n[ \t]*)*$/)?.[0].length ?? 0;
  const a = start + leading;
  const b = Math.max(a, end - trailing);
  spans[key] = { start: a, end: b, value: body.slice(a, b) };
 };
 for (const [key, def] of Object.entries(sectionDefinitions)) {
  for (const range of ranges.filter(r => r.marker === def.marker)) add(key, range.innerStart, range.innerEnd);
 }
 const headings = lines.filter(l => /^##\s+/.test(l.text) && !ranges.some(r => l.start >= r.start && l.start < r.end));
 for (let index = 0; index < headings.length; index++) {
  const heading = headings[index];
  const key = heading.text.replace(/^##\s+/, "").replace(/\s+#+\s*$/, "").replace(/\s*\(Optional\)$/i, "").trim().toLowerCase();
  const end = headings[index + 1]?.start ?? body.length;
  if (!(key in sectionDefinitions)) continue;
  if (markers.some(m => m.start >= heading.end && m.start < end)) continue;
  add(key, heading.end, end);
 }
 // Only expose comment bodies as editable ranges. Author, date, index and delimiters stay byte-identical.
 let commentIndex = 0;
 for (const range of ranges.filter(r => r.marker === "COMMENTS")) {
  const block = body.slice(range.innerStart, range.innerEnd);
  const children = ranges.filter(r => r.marker === "COMMENT" && r.start > range.start && r.end < range.end);
  if (children.length) {
   for (const child of children) {
    const text = body.slice(child.innerStart, child.innerEnd);
    const separator = /\r?\n[ \t]*\r?\n/.exec(text);
    if (separator) add(`comment ${++commentIndex}`, child.innerStart + separator.index + separator[0].length, child.innerEnd);
    else errors.push("Comment metadata has no body separator; edit this comment in Markdown.");
   }
  } else {
   const delimiters = [...block.matchAll(/^---[ \t]*\r?$/gm)];
   if (delimiters.length % 2) errors.push("Comment delimiters are unbalanced.");
   for (let i = 0; i + 1 < delimiters.length; i += 2) {
    const a = delimiters[i], b = delimiters[i + 1];
    add(`comment ${++commentIndex}`, range.innerStart + a.index! + a[0].length, range.innerStart + b.index!);
   }
  }
 }
 return { spans, errors };
}
function parseTask(raw: string, meta: Meta): Task {
 const fallback: Task = { ...meta, id: meta.path.split("/").at(-1) ?? "Invalid task", title: "Unreadable task", status: "Invalid task", ordinal: null, fields: {}, body: raw, sections: {}, errors: [], progress: { done: 0, total: 0 } };
 try {
  const fm = frontmatter(raw);
  const body = raw.slice(fm.end);
  const { spans, errors } = bodySections(body);
  if (typeof fm.data.id !== "string" || !fm.data.id.trim()) errors.push("Task requires a string ID.");
  if (typeof fm.data.title !== "string" || !fm.data.title.trim()) errors.push("Task requires a title.");
  for (const [key, value] of Object.entries(fm.data)) if (key in fieldLabels) {
   // Legacy Backlog permits a single scalar assignee.
   if (key === "assignee" && typeof value === "string") continue;
   try { validateField(key, value as FieldValue); } catch (error) { errors.push((error as Error).message); }
  }
  const checks = Object.entries(spans).filter(([key]) => key === "acceptance criteria" || key === "definition of done").flatMap(([, span]) => [...span.value.matchAll(/^\s*- \[([ xX])\]/gm)]);
  return { ...meta, id: String(fm.data.id ?? fallback.id), title: String(fm.data.title ?? fallback.title), status: String(fm.data.status ?? ""), ordinal: typeof fm.data.ordinal === "number" && Number.isFinite(fm.data.ordinal) ? fm.data.ordinal : null, fields: fm.data, body, sections: Object.fromEntries(Object.entries(spans).map(([key, span]) => [key, span.value])), errors, progress: { done: checks.filter(m => m[1].toLowerCase() === "x").length, total: checks.length } };
 } catch (error) { return { ...fallback, errors: [(error as Error).message] }; }
}
function patchTask(raw: string, edits: Edit[]): string {
 if (!edits.length) return raw;
 const current = parseTask(raw, { path: "", revision: "", storage: "active" });
 if (current.errors.length) throw new Error(current.errors.join(" "));
 const fm = frontmatter(raw);
 const { spans } = bodySections(current.body);
 const changes: Span[] = [];
 const seen = new Set<string>();
 let additions = "";
 for (const edit of edits) {
  const key = edit.kind === "section" ? edit.key.toLowerCase() : edit.key;
  const unique = `${edit.kind}:${key}`;
  if (seen.has(unique)) throw new Error("Duplicate field edit.");
  seen.add(unique);
  const actual = edit.kind === "field" ? current.fields[key] ?? null : current.sections[key] ?? null;
  if (JSON.stringify(typeof actual === "string" && edit.kind === "section" ? actual.replace(/\r\n/g, "\n") : actual) !== JSON.stringify(typeof edit.before === "string" && edit.kind === "section" ? edit.before.replace(/\r\n/g, "\n") : edit.before)) throw new Error(`Conflict: ${key} changed on disk.`);
  if (edit.kind === "section") {
   if (!(key in sectionDefinitions) && !/^comment \d+$/.test(key)) throw new Error("This section is read-only.");
   if (typeof edit.value !== "string") throw new Error("Section content must be Markdown text.");
   if (/<!--\s*(?:SECTION:|AC:|DOD:|COMMENT)/i.test(edit.value)) throw new Error("Edit section text without adding or removing Backlog markers.");
   if (key.startsWith("comment ") && /^---\s*$/m.test(edit.value)) throw new Error("Comment text cannot contain standalone delimiters.");
   const value = edit.value.replace(/\r\n|\n/g, fm.newline);
   const span = spans[key];
   if (span) changes.push({ start: fm.end + span.start, end: fm.end + span.end, value });
   else {
    const def = sectionDefinitions[key];
    if (!def) throw new Error("Comment no longer exists.");
    changes.push({ start: raw.length, end: raw.length, value: `${fm.newline}${fm.newline}## ${def.title}${fm.newline}${fm.newline}<!-- ${def.marker}:BEGIN -->${fm.newline}${value}${fm.newline}<!-- ${def.marker}:END -->${fm.newline}` });
   }
  } else {
   validateField(key, edit.value);
   if (!isMap(fm.doc.contents)) throw new Error("Invalid YAML mapping.");
   const pair = fm.doc.contents.items.find(p => isScalar(p.key) && p.key.value === key);
   const encoded = JSON.stringify(edit.value);
   if (!pair) { additions += `${key}: ${encoded}${fm.newline}`; continue; }
   const node = pair.value;
   if (!isNode(node) || !node.range) throw new Error(`Cannot safely locate ${key}.`);
   let anchored = false;
   const comments: string[] = [];
   visit(node, (_key, item) => {
    if (!isNode(item)) return;
    if (isAlias(item) || ("anchor" in item && item.anchor)) anchored = true;
    if (item !== node && "comment" in item && item.comment) comments.push(item.comment);
    if ("commentBefore" in item && item.commentBefore) comments.push(item.commentBefore);
   });
   if (anchored) throw new Error(`Edit anchored YAML field ${key} directly in Markdown.`);
   const previous = fm.text.slice(node.range[0], node.range[1]);
   const suffix = previous.endsWith("\n") ? fm.newline : "";
   const retained = comments.length ? fm.newline + comments.flatMap(c => c.split("\n").map(line => `  #${line}`)).join(fm.newline) : "";
   changes.push({ start: fm.start + node.range[0], end: fm.start + node.range[1], value: encoded + retained + suffix });
  }
 }
 if (additions) changes.push({ start: fm.start + fm.text.length, end: fm.start + fm.text.length, value: additions });
 let output = raw;
 for (const change of changes.sort((a, b) => b.start - a.start)) output = output.slice(0, change.start) + change.value + output.slice(change.end);
 const verified = parseTask(output, { path: "", revision: "", storage: "active" });
 if (verified.errors.length) throw new Error(`Patched task is invalid: ${verified.errors.join(" ")}`);
 for (const edit of edits) {
  const actual = edit.kind === "field" ? verified.fields[edit.key] ?? null : verified.sections[edit.key.toLowerCase()] ?? null;
  if (JSON.stringify(typeof actual === "string" && edit.kind === "section" ? actual.replace(/\r\n/g, "\n") : actual) !== JSON.stringify(typeof edit.value === "string" && edit.kind === "section" ? edit.value.replace(/\r\n/g, "\n") : edit.value)) throw new Error(`Cannot safely represent ${edit.key}; edit it in Markdown.`);
 }
 return output;
}

// ---- discovery (adapted from src/discovery.ts, host IO via bb.sdk) ----
interface Config { statuses: string[]; priorities: string[]; types: string[]; projects: string[]; prefix: string; defaultStatus: string | null }
const defaultConfig: Config = { statuses: ["To Do", "In Progress", "Done"], priorities: ["high", "medium", "low"], types: ["bug", "feature", "enhancement", "task", "chore", "docs", "spike"], projects: [], prefix: "task", defaultStatus: null };
function parseConfig(raw: string): Record<string, unknown> {
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid Backlog configuration: ${doc.errors[0].message}`);
  const value: unknown = doc.toJS({ maxAliasCount: 50 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backlog configuration must be a YAML mapping.");
  return value as Record<string, unknown>;
}
function normalizeConfig(data: Record<string, unknown>): Config {
  const choices = (key: string, fallback: string[]) => {
    const value = data[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return fallback;
    if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim()) || new Set(value).size !== value.length) throw new Error(`Backlog ${key} must be a list of unique non-empty strings.`);
    return value as string[];
  };
  const prefix = typeof data.task_prefix === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(data.task_prefix.trim()) ? data.task_prefix.trim() : defaultConfig.prefix;
  const statuses = choices("statuses", defaultConfig.statuses);
  const defaultStatus = typeof data.default_status === "string" && statuses.includes(data.default_status) ? data.default_status : null;
  return { statuses, priorities: choices("priorities", defaultConfig.priorities).map(v => v.toLowerCase()), types: choices("types", defaultConfig.types), projects: choices("projects", []), prefix, defaultStatus };
}
const absoluteFolder = (root: string, value: string) => {
  if (!value.trim() || value.includes("\0") || value.includes("\\")) throw new Error("backlog_directory must be a folder path.");
  return path.resolve(root, value.trim());
};
/** Only these three storage folders are ever written. */
function confinedTaskPath(folder: string, candidate: string): string {
  const absolute = path.resolve(folder, candidate);
  const relative = path.relative(folder, absolute);
  if (!/^(tasks|completed|archive\/tasks)\/[^/]+\.md$/i.test(relative) || relative.split("/").includes("..")) throw new Error("Task path is outside the selected task directories.");
  return absolute;
}
const STORAGE = [["tasks", "active"], ["completed", "completed"], ["archive/tasks", "archived"]] as const;
const storageOf = (folder: string, file: string): Task["storage"] => {
  const relative = path.relative(folder, file);
  return relative.startsWith("archive/") ? "archived" : relative.startsWith("completed/") ? "completed" : "active";
};

// ---- Chief module (Chief's own code) ----
export const backlogRpc = {
  backlogProjects: { input: z.null(), output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }).strict() },
  backlogBoard: { input: z.object({ projectId: z.string().trim().min(1) }).strict(), output: boardSchema },
  backlogCreate: { input: z.object({ projectId: z.string().trim().min(1), title: z.string().trim().min(1).max(200), status: z.string().optional(), description: z.string().optional() }).strict(), output: z.object({ task: taskSchema.nullable(), conflict: z.boolean(), message: z.string() }).strict() },
  backlogSave: { input: z.object({ projectId: z.string().trim().min(1), path: z.string(), revision: z.string(), edits: z.array(editSchema).min(1).max(20) }).strict(), output: z.object({ task: taskSchema.nullable(), conflict: z.boolean(), message: z.string() }).strict() },
  backlogMove: { input: z.object({ projectId: z.string().trim().min(1), path: z.string(), revision: z.string(), status: z.string(), before: z.string().nullable() }).strict(), output: z.object({ task: taskSchema.nullable(), conflict: z.boolean(), message: z.string() }).strict() },
  backlogArchive: { input: z.object({ projectId: z.string().trim().min(1), path: z.string(), revision: z.string() }).strict(), output: z.object({ task: taskSchema.nullable(), conflict: z.boolean(), message: z.string() }).strict() },
};
type RpcIn<K extends keyof typeof backlogRpc> = z.infer<(typeof backlogRpc)[K]["input"]>;
type MutationResult = z.infer<typeof backlogRpc.backlogSave.output>;

export interface BacklogDeps {
  /** Live read of the `backlogEnabled` setting. */
  enabled(): boolean;
  projectSource(projectId: string): Promise<{ hostId: string; path: string } | null>;
  linksFor(projectId: string, taskId: string): BacklogLink[];
  /** Called after a refresh changed what the cache holds. */
  onChange(projectId: string): void;
  /** Only projects with a Chief get a board. */
  hasChief(projectId: string): boolean;
  projects(): Promise<Array<{ id: string; name: string }>>;
}
export interface BacklogState {
  kind: "off" | "missing" | "ambiguous" | "ready";
  /** False until the first refresh of this project finished. */
  loaded: boolean;
  folder: string | null;
  message: string;
  candidates: string[];
  statuses: string[];
  tasks: Task[];
}
export interface BacklogTodo { id: string; text: string; after: string | null; state: "open" | "done" | "dropped"; updatedAt: number }

interface Cache extends BacklogState {
  hostId: string | null;
  config: Config;
  warnings: string[];
  sig: string;
}
class ConflictError extends Error {}
const SIZE_LIMIT = 512 * 1024;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const titleOf = (text: string) => text.split("\n").map(line => line.trim()).find(Boolean)?.slice(0, 200) ?? "";
const taskAfter = (task: Task) => typeof task.fields.chief_after === "string" && task.fields.chief_after.trim() ? task.fields.chief_after : null;
const taskTime = (task: Task) => {
  const stamp = Date.parse(String(task.fields.updated_date ?? task.fields.created_date ?? "").replace(" ", "T") + "Z");
  return Number.isFinite(stamp) ? stamp : 0;
};
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function createBacklog(bb: BbPluginApi, deps: BacklogDeps) {
  const caches = new Map<string, Cache>();
  const chains = new Map<string, Promise<unknown>>();
  const locks = new Map<string, Promise<unknown>>();
  const emptyState = (kind: BacklogState["kind"], loaded: boolean, message = ""): BacklogState => ({ kind, loaded, folder: null, message, candidates: [], statuses: [], tasks: [] });

  /** Synchronous: reads only the cache. */
  function state(projectId: string): BacklogState {
    if (!deps.enabled()) return emptyState("off", true);
    return caches.get(projectId) ?? emptyState("missing", false, "Reading the Backlog folder…");
  }
  function ready(projectId: string) {
    const cache = caches.get(projectId);
    if (!deps.enabled() || !cache || cache.kind !== "ready" || !cache.folder || !cache.hostId) throw new Error("The Backlog board is not ready for this project.");
    return { ...cache, folder: cache.folder, hostId: cache.hostId };
  }

  async function readText(hostId: string, file: string, rootPath: string) {
    const result = await bb.sdk.files.read({ hostId, path: file, rootPath });
    if (result.contentEncoding !== "utf8") throw new Error(`Not a UTF-8 text file: ${file}`);
    if (result.sizeBytes > SIZE_LIMIT) throw new Error(`Markdown file exceeds the 512 KiB editing limit: ${file}`);
    return { raw: result.content, revision: result.sha256 };
  }
  async function discover(source: { hostId: string; path: string }): Promise<Pick<Cache, "kind" | "folder" | "message" | "candidates" | "config">> {
    const { hostId, path: root } = source;
    const rootConfig = path.join(root, "backlog.config.yml");
    const candidates = [path.join(root, "backlog"), path.join(root, ".backlog")];
    const existence = (await bb.sdk.hosts.pathsExist({ hostId, paths: [rootConfig, ...candidates] })).existence;
    const rootData = existence[rootConfig] ? parseConfig((await readText(hostId, rootConfig, root)).raw) : {};
    let folder: string | null = null;
    if (rootData.backlog_directory !== undefined) {
      if (typeof rootData.backlog_directory !== "string") throw new Error("backlog_directory must be a folder path.");
      folder = absoluteFolder(root, rootData.backlog_directory);
    } else {
      const found = candidates.filter(p => existence[p]);
      if (found.length > 1) return { kind: "ambiguous", folder: null, candidates: found, message: "Both backlog/ and .backlog/ exist. Remove one, or set backlog_directory in backlog.config.yml.", config: normalizeConfig(rootData) };
      folder = found[0] ?? null;
    }
    if (!folder || !(await bb.sdk.hosts.pathsExist({ hostId, paths: [folder] })).existence[folder]) return { kind: "missing", folder, candidates: [], message: folder ? `Folder not found: ${folder}` : `No backlog/ or .backlog/ folder in ${root}.`, config: normalizeConfig(rootData) };
    const legacy = path.join(folder, "config.yml");
    const legacyData = (await bb.sdk.hosts.pathsExist({ hostId, paths: [legacy] })).existence[legacy] ? parseConfig((await readText(hostId, legacy, folder)).raw) : {};
    return { kind: "ready", folder, candidates: [], message: "", config: normalizeConfig({ ...legacyData, ...rootData }) };
  }
  async function listFiles(hostId: string, folder: string) {
    const warnings: string[] = [];
    const files: Array<{ path: string; storage: Task["storage"] }> = [];
    const dirs = STORAGE.map(([relative, storage]) => ({ dir: path.join(folder, relative), storage }));
    const existence = (await bb.sdk.hosts.pathsExist({ hostId, paths: dirs.map(d => d.dir) })).existence;
    for (const { dir, storage } of dirs.filter(d => existence[d.dir])) {
      let names: string[];
      try {
        names = (await bb.sdk.hosts.directory({ hostId, path: dir })).entries.filter(e => e.kind === "file").map(e => path.join(dir, e.name));
      } catch (error) {
        // ponytail: hosts.directory cap/visibility is unverified; listPaths is the documented fallback.
        const listed = await bb.sdk.files.listPaths({ hostId, path: dir, includeFiles: true, includeDirectories: false, includeHidden: true, limit: 3000 });
        if (listed.truncated) warnings.push(`Task scan limit reached in ${dir}.`);
        names = listed.paths.map(p => p.path).filter(p => path.dirname(p) === dir);
        bb.log.warn(`hosts.directory failed for ${dir}, used listPaths: ${errorMessage(error)}`);
      }
      for (const name of names) if (/\.md$/i.test(name)) files.push({ path: name, storage });
    }
    return { files, warnings };
  }

  async function load(projectId: string): Promise<void> {
    if (!deps.enabled()) { caches.delete(projectId); return; }
    const previous = caches.get(projectId);
    let next: Cache;
    try {
      const source = await deps.projectSource(projectId);
      if (!source) next = { ...emptyState("missing", true, "This project has no checkout on a connected machine."), hostId: null, config: defaultConfig, warnings: [], sig: "" };
      else {
        const found = await discover(source);
        next = { ...emptyState(found.kind, true, found.message), folder: found.folder, candidates: found.candidates, statuses: found.config.statuses, hostId: source.hostId, config: found.config, warnings: [], sig: "" };
        if (found.kind === "ready" && found.folder) {
          const listing = await listFiles(source.hostId, found.folder);
          next.warnings = listing.warnings;
          const reuse = new Map((previous?.tasks ?? []).filter(t => t.storage !== "active" && previous?.folder === found.folder).map(t => [t.path, t]));
          const tasks: Task[] = [];
          let bytes = 0;
          for (let i = 0; i < listing.files.length; i += 12) {
            await Promise.all(listing.files.slice(i, i + 12).map(async file => {
              // ponytail: completed/archived files are read once per path; active ones every refresh. Add a watcher or mtime check if boards get large.
              const cached = reuse.get(file.path);
              if (cached && file.storage !== "active") { tasks.push(cached); return; }
              try {
                confinedTaskPath(found.folder!, file.path);
                const record = await readText(source.hostId, file.path, found.folder!);
                bytes += Buffer.byteLength(record.raw);
                if (bytes > 5 * 1024 * 1024) throw new Error("Board exceeds the 5 MiB content limit.");
                tasks.push(parseTask(record.raw, { path: file.path, revision: record.revision, storage: file.storage }));
              } catch (error) { next.warnings.push(`${path.basename(file.path)}: ${errorMessage(error)}`); }
            }));
          }
          const ids = new Map<string, Task[]>();
          for (const task of tasks) ids.set(task.id.toLowerCase(), [...(ids.get(task.id.toLowerCase()) ?? []), task]);
          for (const [id, same] of ids) if (same.length > 1) for (const task of same) task.errors.push(`Duplicate task ID ${id}; resolve duplicates before editing.`);
          next.tasks = tasks.sort(compareTasks);
        }
      }
    } catch (error) {
      // A broken config or an unreachable host is a visible note, never a thrown error.
      next = { ...emptyState("missing", true, errorMessage(error)), hostId: null, config: defaultConfig, warnings: [], sig: "" };
    }
    next.sig = JSON.stringify([next.kind, next.folder, next.message, next.statuses, next.warnings, next.tasks.map(t => [t.path, t.revision])]);
    if (!deps.enabled()) { caches.delete(projectId); return; }
    caches.set(projectId, next);
    if (next.sig !== previous?.sig) deps.onChange(projectId);
  }
  /** Rediscover, list, parse and replace the cache. ponytail: polled; edits made outside Chief show within one RECONCILE_INTERVAL_MS (30s); add a watcher if that is too slow. */
  function refresh(projectId: string): Promise<void> {
    const next = (chains.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(() => load(projectId));
    chains.set(projectId, next);
    return next;
  }
  /** Creates (and todo adds) run one at a time per project. */
  function withLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const run = (locks.get(projectId) ?? Promise.resolve()).catch(() => undefined).then(work);
    locks.set(projectId, run.catch(() => undefined));
    return run;
  }

  function validateChoices(edits: Edit[], config: Config) {
    for (const edit of edits) {
      if (edit.kind !== "field") continue;
      if (edit.key === "status" && !config.statuses.includes(String(edit.value))) throw new Error("Choose a status from the Backlog configuration.");
      if ((edit.key === "type" || edit.key === "project") && edit.value !== null && edit.value !== "") {
        const options = edit.key === "type" ? config.types : config.projects;
        if (!options.some(value => value.toLowerCase() === String(edit.value).toLowerCase())) throw new Error(`Choose a configured ${edit.key}: ${options.join(", ") || "none configured"}.`);
      }
      if (edit.key === "priority" && edit.value !== null && edit.value !== "" && !config.priorities.includes(String(edit.value).toLowerCase())) throw new Error(`Priority must be one of: ${config.priorities.join(", ")}.`);
    }
  }
  const field = (task: Task, key: string, value: FieldValue): Edit => ({ kind: "field", key, before: (task.fields[key] as FieldValue | undefined) ?? null, value });

  /**
   * Hash-guarded edit. `expect` is the revision the caller rendered (board); without it the
   * tool path patches against a fresh read. A write conflict re-reads once and retries only
   * if the patch's `before` values still match; otherwise it fails with a clear message.
   */
  async function mutate(projectId: string, file: string, build: (fresh: Task) => Edit[], expect?: string): Promise<Task> {
    const c = ready(projectId);
    const absolute = confinedTaskPath(c.folder, file);
    let expected = expect;
    for (let attempt = 0; ; attempt++) {
      const current = await readText(c.hostId, absolute, c.folder);
      if (expected !== undefined && current.revision !== expected) throw new ConflictError("This task changed since the board loaded it.");
      const meta = { path: absolute, revision: current.revision, storage: storageOf(c.folder, absolute) };
      const fresh = parseTask(current.raw, meta);
      if (fresh.errors.length) throw new Error(fresh.errors.join(" "));
      const edits = build(fresh);
      validateChoices(edits, c.config);
      let content: string;
      try { content = patchTask(current.raw, edits); }
      catch (error) {
        if (/^Conflict:/.test(errorMessage(error))) throw new ConflictError(`Task ${fresh.id} changed since it was read; re-read it and retry.`);
        throw error;
      }
      const result = await bb.sdk.files.write({ hostId: c.hostId, path: absolute, rootPath: c.folder, content, expectedSha256: current.revision, createParents: false });
      if (result.outcome === "written") return parseTask(content, { ...meta, revision: result.sha256 });
      if (attempt >= 1) throw new ConflictError(`Task ${fresh.id} changed since it was read; re-read it and retry.`);
      expected = undefined;
    }
  }
  /** Move between tasks/, completed/ and archive/tasks/ after a sha check. ponytail: check-then-move is not atomic. */
  async function relocate(projectId: string, file: string, target: "tasks" | "archive/tasks", expect?: string): Promise<Task> {
    const c = ready(projectId);
    const source = confinedTaskPath(c.folder, file);
    const destination = confinedTaskPath(c.folder, path.join(c.folder, target, path.basename(source)));
    const current = await readText(c.hostId, source, c.folder);
    if (expect !== undefined && current.revision !== expect) throw new ConflictError("This task changed since the board loaded it.");
    if ((await bb.sdk.hosts.pathsExist({ hostId: c.hostId, paths: [destination] })).existence[destination]) throw new Error(`${path.basename(destination)} already exists in ${target}/.`);
    await bb.sdk.files.mkdir({ hostId: c.hostId, path: path.dirname(destination), rootPath: c.folder, recursive: true });
    await bb.sdk.files.move({ hostId: c.hostId, sourcePath: source, destinationPath: destination, rootPath: c.folder });
    return parseTask(current.raw, { path: destination, revision: current.revision, storage: storageOf(c.folder, destination) });
  }

  const find = (projectId: string, taskId: string) => state(projectId).tasks.find(t => sameId(t.id, taskId));
  const doneStatus = (projectId: string) => state(projectId).statuses.at(-1) ?? "Done";
  const firstStatus = (c: Cache) => c.config.defaultStatus ?? c.statuses[0]!;
  /** Insertion order for a lane; omitted when the lane has unordered tasks (see insertionOrdinal). */
  function ordinalFor(tasks: Task[], status: string, movingPath: string, before: string | null): number | null {
    try { return insertionOrdinal(tasks.filter(t => t.storage === "active"), movingPath, status, before); } catch { return null; }
  }

  async function createTask(projectId: string, input: { title: string; status?: string; description?: string; after?: string | null; id?: string; onAllocated?: (id: string) => void }): Promise<Task> {
    return withLock(projectId, async () => {
      await load(projectId);
      const c = ready(projectId);
      const title = input.title.replace(/\s+/g, " ").trim();
      if (!title) throw new Error("A task needs a title.");
      // ponytail: a resumed import trusts that its pre-allocated id still names its own task; a foreign task that took the number meanwhile would be returned instead.
      if (input.id) { const existing = find(projectId, input.id); if (existing) return existing; }
      const status = input.status ?? firstStatus(c);
      if (!c.statuses.includes(status)) throw new Error(`Status must be one of: ${c.statuses.join(", ")}.`);
      if (input.description && /<!--\s*(?:SECTION:|AC:|DOD:|COMMENT)/i.test(input.description)) throw new Error("The description cannot contain Backlog section markers.");
      // Highest number across ids and file names (also files that failed to parse), plus one.
      const numbers = [...c.tasks.map(t => t.id), ...c.tasks.map(t => path.basename(t.path))].map(s => /(\d+)(?: - .*)?(?:\.md)?$/i.exec(s)?.[1]).filter((n): n is string => !!n).map(Number);
      const number = Math.max(0, ...numbers) + 1;
      const id = input.id ?? `${c.config.prefix.toUpperCase()}-${number}`;
      const slug = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "") || "task";
      const file = path.join(c.folder, "tasks", `${id.toLowerCase()} - ${slug}.md`);
      confinedTaskPath(c.folder, file);
      input.onAllocated?.(id);
      const ordinal = ordinalFor(c.tasks, status, "", null);
      const created = new Date().toISOString().slice(0, 16).replace("T", " ");
      const description = input.description?.trim();
      const content = [
        "---", `id: ${id}`, `title: ${JSON.stringify(title)}`, `status: ${JSON.stringify(status)}`, `created_date: '${created}'`, "labels: []", "dependencies: []",
        ...(ordinal === null ? [] : [`ordinal: ${ordinal}`]), ...(input.after ? [`chief_after: ${JSON.stringify(input.after)}`] : []), "---", "",
        ...(description ? ["## Description", "", "<!-- SECTION:DESCRIPTION:BEGIN -->", description, "<!-- SECTION:DESCRIPTION:END -->", ""] : []),
      ].join("\n");
      // ponytail: the Backlog CLI and the Backlog.MD plugin are outside this lock; a simultaneous external create can pick the same id.
      // expectedSha256:null is not verified to refuse an existing file, so check inside the lock.
      if ((await bb.sdk.hosts.pathsExist({ hostId: c.hostId, paths: [file] })).existence[file]) throw new Error(`${path.basename(file)} already exists.`);
      const result = await bb.sdk.files.write({ hostId: c.hostId, path: file, rootPath: c.folder, content, expectedSha256: null, createParents: true });
      if (result.outcome !== "written") throw new Error(`${path.basename(file)} appeared while creating it; try again.`);
      await load(projectId);
      return find(projectId, id) ?? parseTask(content, { path: file, revision: result.sha256, storage: "active" });
    });
  }
  async function editTask(projectId: string, input: { path: string; revision?: string; edits: Edit[] }): Promise<Task> {
    const task = await mutate(projectId, input.path, () => input.edits, input.revision);
    await load(projectId);
    return task;
  }
  async function moveTask(projectId: string, input: { path: string; revision?: string; status: string; before?: string | null }): Promise<Task> {
    const task = await mutate(projectId, input.path, fresh => {
      const ordinal = ordinalFor(state(projectId).tasks, input.status, fresh.path, input.before ?? null);
      return [field(fresh, "status", input.status), ...(ordinal === null ? [] : [field(fresh, "ordinal", ordinal)])];
    }, input.revision);
    await load(projectId);
    return task;
  }
  async function archiveTask(projectId: string, input: { path: string; revision?: string }): Promise<Task> {
    const task = await relocate(projectId, input.path, "archive/tasks", input.revision);
    await load(projectId);
    return task;
  }
  /** Back to tasks/ with the first status. */
  async function restoreTask(projectId: string, input: { path: string; revision?: string }): Promise<Task> {
    const c = ready(projectId);
    const reset = await mutate(projectId, input.path, fresh => [field(fresh, "status", firstStatus(c))], input.revision);
    const task = await relocate(projectId, reset.path, "tasks");
    await load(projectId);
    return { ...task, status: firstStatus(c) };
  }

  /** chief_roster todo add. A long first line is the title; the rest is the description. */
  function addTodo(projectId: string, input: { text: string; after?: string | null; id?: string; onAllocated?: (id: string) => void }): Promise<Task> {
    const title = titleOf(input.text);
    const rest = input.text.trim() === title ? "" : input.text.trim();
    return createTask(projectId, { title, description: rest, after: input.after, id: input.id, onAllocated: input.onAllocated });
  }
  /** chief_roster todo change: text/after edit, then done (last status), dropped (archive) or open (restore). */
  async function updateTodo(projectId: string, input: { id: string; text?: string; after?: string | null; state?: BacklogTodo["state"] }): Promise<Task> {
    await load(projectId);
    const c = ready(projectId);
    const found = find(projectId, input.id);
    if (!found) throw new Error(`No backlog task ${input.id} in this project.`);
    let task = found;
    const wanted = input.state ?? (task.storage === "archived" ? "dropped" : task.status === c.statuses.at(-1) ? "done" : "open");
    const wasInactive = task.storage !== "active";
    if (wasInactive && wanted !== "dropped") task = await restoreTask(projectId, { path: task.path });
    const status = wanted === "done" ? c.statuses.at(-1)! : wanted === "open" && !wasInactive && task.status === c.statuses.at(-1) ? firstStatus(c) : null;
    const text = input.text === undefined ? null : titleOf(input.text);
    if (input.text !== undefined && !text) throw new Error("A task needs a title.");
    if (text !== null || input.after !== undefined || (status !== null && status !== task.status)) {
      task = await mutate(projectId, task.path, fresh => [
        ...(text !== null && text !== fresh.title ? [field(fresh, "title", text)] : []),
        ...(input.after !== undefined ? [field(fresh, "chief_after", input.after || null)] : []),
        ...(status !== null && status !== fresh.status ? [field(fresh, "status", status)] : []),
      ]);
    }
    if (wanted === "dropped" && task.storage !== "archived") task = await relocate(projectId, task.path, "archive/tasks");
    await load(projectId);
    return find(projectId, task.id) ?? task;
  }

  /** The cache as chief_todos-shaped rows: open = unfinished in tasks/, done = last status or completed/, dropped = archived. */
  function todos(projectId: string): BacklogTodo[] {
    const last = doneStatus(projectId);
    return state(projectId).tasks.filter(t => !t.errors.length).map(task => ({
      id: task.id, text: task.title, after: taskAfter(task), updatedAt: taskTime(task),
      state: task.storage === "archived" ? "dropped" as const : task.storage === "completed" || task.status === last ? "done" as const : "open" as const,
    }));
  }

  function board(projectId: string): BacklogBoard {
    const s = state(projectId);
    const cache = caches.get(projectId);
    const choices: Record<string, string[]> = s.kind === "ready" && cache ? { priority: cache.config.priorities, type: cache.config.types, project: cache.config.projects } : {};
    return {
      enabled: deps.enabled(), kind: s.kind, projectId, folder: s.folder, message: s.message, candidates: s.candidates, statuses: s.statuses, choices,
      warnings: cache?.warnings ?? [],
      tasks: s.tasks.map(task => ({ ...task, after: taskAfter(task), links: deps.linksFor(projectId, task.id) })),
    };
  }
  function guard(projectId: string) {
    if (!deps.hasChief(projectId)) throw new Error("No Chief is running in this project.");
    if (!deps.enabled()) throw new Error("The Backlog board is off. Turn on “Backlog board” in Chief's settings.");
  }
  async function attempt(projectId: string, work: () => Promise<Task>): Promise<MutationResult> {
    guard(projectId);
    try { return { task: await work(), conflict: false, message: "" }; }
    catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      await load(projectId);
      return { task: null, conflict: true, message: error.message };
    }
  }

  const rpcHandlers = {
    backlogProjects: async () => ({ projects: await deps.projects() }),
    backlogBoard: async ({ projectId }: RpcIn<"backlogBoard">) => {
      if (deps.enabled() && deps.hasChief(projectId)) await refresh(projectId);
      return board(projectId);
    },
    backlogCreate: ({ projectId, ...input }: RpcIn<"backlogCreate">) => attempt(projectId, () => createTask(projectId, input)),
    backlogSave: ({ projectId, ...input }: RpcIn<"backlogSave">) => attempt(projectId, () => editTask(projectId, input)),
    backlogMove: ({ projectId, ...input }: RpcIn<"backlogMove">) => attempt(projectId, () => moveTask(projectId, input)),
    backlogArchive: ({ projectId, ...input }: RpcIn<"backlogArchive">) => attempt(projectId, () => archiveTask(projectId, input)),
  };
  return { state, refresh, createTask, editTask, moveTask, archiveTask, restoreTask, addTodo, updateTodo, todos, rpcHandlers, forget: (projectId: string) => void caches.delete(projectId) };
}
