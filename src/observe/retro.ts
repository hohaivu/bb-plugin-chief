import { createHash } from "node:crypto";
import { z } from "zod";
import { clip } from "../core/text";
import { READ_ONLY } from "../core/roles";
import type { ManagedRow } from "../types";
import type { Ctx } from "../runtime/context";
import { agyDbPath, failedStatus, readAgySteps, RECENT_STEPS } from "./agyHistory";
import { type Aggregate, aggregate, applicableRubrics, INSUFFICIENT, lessonRole, NOT_APPLICABLE, renderRubric, RUBRIC_VERSION, rubricByName, RUBRICS, type ScoreInput, SURFACES, type ThreadStatus } from "./rubrics";
import { normalize, scrub } from "./scrub";
import { configuredSecrets, EVENT_PAGE, listEvents, type LooseEvent as Loose, providerThreadId, recentEvents, sentryIssuesForTag, textOfContent as textOf } from "./sources";

/** Bounds from the plan: 3 attempts, 10 minutes between them, 2 h for one run, 2 starts per tick, 8 judged threads plus one communication call. */
const MAX_ATTEMPTS = 3;
const RETRY_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_STARTS = 2;
const MAX_THREADS = 8;
const FILE_CHARS = 120_000;
const HEAD_EVENTS = 400;
const TAIL_EVENTS = 1_200;
const MAX_HEAD_PAGES = 30;
const MAX_TAIL_PAGES = 12;
const RUNNING_RUN = new Set(["queued", "running"]);

/** Inline workflow source. It reads only `args` (each job is a finished prompt), so no value is ever interpolated into it. */
export const RETRO_SCRIPT = String.raw`export const meta = {
  name: "chief-retro-judge",
  description: "Read-only retro: score each sampled thread and the Chief handoffs against the rubrics",
  phases: [{ title: "Judge" }],
};
const models = args.models || {};
const LESSON = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      properties: {
        surface: { type: "string" }, rule: { type: "string" }, missingOrWrong: { type: "string" }, prevents: { type: "string" },
        recurrence: { type: "string", enum: ["recurs", "severe"] },
        existingInstruction: { anyOf: [{ type: "string" }, { type: "null" }] },
        evidence: { type: "array", items: { type: "string" } },
      },
      required: ["surface", "rule", "missingOrWrong", "prevents", "recurrence", "existingInstruction", "evidence"],
      additionalProperties: false,
    },
  ],
};
const STRINGS = { type: "array", items: { type: "string" } };
const THREAD = {
  type: "object",
  properties: {
    threadId: { type: "string" },
    scores: { type: "array", items: { type: "object", properties: { scorer: { type: "string" }, label: { type: "string" }, reason: { type: "string" }, evidence: STRINGS }, required: ["scorer", "label", "reason", "evidence"], additionalProperties: false } },
    lesson: LESSON,
  },
  required: ["threadId", "scores", "lesson"],
  additionalProperties: false,
};
const SIGNAL = { anyOf: [{ type: "boolean" }, { type: "null" }] };
const COMM = {
  type: "object",
  properties: {
    handoffs: { type: "array", items: { type: "object", properties: {
      threadId: { type: "string" }, label: { type: "string" }, reason: { type: "string" },
      signals: { type: "object", properties: { briefGapBlock: SIGNAL, askedTwice: SIGNAL, unclearBriefRounds: SIGNAL, userWordsLost: SIGNAL }, required: ["briefGapBlock", "askedTwice", "unclearBriefRounds", "userWordsLost"], additionalProperties: false },
      evidence: STRINGS,
    }, required: ["threadId", "label", "reason", "signals", "evidence"], additionalProperties: false } },
    lessons: { type: "array", items: LESSON.anyOf[1] },
  },
  required: ["handoffs", "lessons"],
  additionalProperties: false,
};
const limit = Math.min(args.cap, budget().maxAgentCalls);
if (args.jobs.length > limit) throw new Error("Retro needs " + args.jobs.length + " agent calls; the limit is " + limit + ".");
const results = await parallel(args.jobs.map((job) => () => agent(
  args.preamble + "\n\n" + job.prompt,
  Object.assign({ phase: "Judge", schema: job.kind === "communication" ? COMM : THREAD }, models.judge || {}),
)));
const threads = [];
let communication = null;
args.jobs.forEach((job, i) => { if (job.kind === "communication") communication = results[i] || null; else threads.push(results[i] || null); });
const lost = results.filter((result) => !result).length;
if (lost === args.jobs.length) throw new Error("All " + lost + " judge calls failed. See the failed calls for the provider error.");
return { threads, communication, lost };
`;

/** What the judge may cite and who it may score: written beside the bundle so the collector validates against the exact files the judge read. */
export interface Manifest {
  version: string;
  planId: string;
  title: string;
  chiefThreadId: string;
  projectId: string;
  threads: { threadId: string; role: string; kind: string | null; title: string; file: string; applicable: string[]; unavailable: string | null }[];
  handoffs: { threadId: string; role: string; title: string; unavailable: string | null; observed: Observed }[];
  handoffFile: string | null;
  /** threadId → seqs that appear as a `#seq` line in a bundle file. */
  refs: Record<string, number[]>;
  dropped: string[];
}
export interface Observed { nudges: number; blocks: number; reviewRounds: number; briefChars: number | null; alertChars: number; estTokens: number | null }

const lessonSchema = z.object({
  surface: z.string(), rule: z.string(), missingOrWrong: z.string(), prevents: z.string(),
  recurrence: z.enum(["recurs", "severe"]), existingInstruction: z.string().nullable(), evidence: z.array(z.string()),
});
const threadResultSchema = z.object({
  threadId: z.string(),
  scores: z.array(z.object({ scorer: z.string(), label: z.string(), reason: z.string(), evidence: z.array(z.string()).default([]) })),
  lesson: z.unknown().nullable().default(null),
});
const handoffResultSchema = z.object({
  threadId: z.string(), label: z.string(), reason: z.string(),
  signals: z.record(z.string(), z.boolean().nullable()).default({}), evidence: z.array(z.string()).default([]),
});
const topSchema = z.object({
  threads: z.array(z.unknown()).default([]),
  communication: z.object({ handoffs: z.array(z.unknown()).default([]), lessons: z.array(z.unknown()).default([]) }).nullable().default(null),
});

export interface ScoreLine { scorer: string; label: string; score: number | null; reason: string }
export interface ThreadOutcome { threadId: string; role: string; title: string; lines: ScoreLine[]; aggregate: Aggregate }
export interface HandoffOutcome { threadId: string; role: string; line: ScoreLine; status: ThreadStatus; signals: Record<string, boolean | null>; evidence: string[]; observed: Observed; unavailable: string | null }
export interface Lesson { sourceThread: string; surface: string; rule: string; missingOrWrong: string; prevents: string; recurrence: string; evidence: string[] }
export interface Evaluation { threads: ThreadOutcome[]; handoffs: HandoffOutcome[]; lessons: Lesson[]; dropped: { rule: string; reason: string }[]; notes: string[] }

/** Pure: validates a judge result against its manifest, aggregates each thread and files lessons only through the four-condition bar. */
export function evaluate(raw: unknown, manifest: Manifest): Evaluation {
  const notes: string[] = [];
  const dropped: { rule: string; reason: string }[] = [];
  const allowed = new Map(Object.entries(manifest.refs).map(([id, seqs]) => [id, new Set(seqs)]));
  const refOk = (ref: string) => { const match = /^(thr_\w+)#(\d+)$/.exec(ref.trim()); return !!match && allowed.get(match[1]!)?.has(Number(match[2])) === true; };
  const top = topSchema.safeParse(raw);
  if (!top.success) notes.push("the judge result was unreadable; every thread counts as insufficient");
  const data = top.success ? top.data : { threads: [], communication: null };

  const given = new Map<string, z.infer<typeof threadResultSchema>>();
  for (const element of data.threads) {
    const parsed = threadResultSchema.safeParse(element);
    if (!parsed.success) { if (element) notes.push("a thread result was malformed and dropped"); continue; }
    const id = parsed.data.threadId;
    if (!manifest.threads.some((entry) => entry.threadId === id)) { notes.push(`dropped a result for ${id}: not a requested thread`); continue; }
    if (given.has(id)) { notes.push(`dropped a duplicate result for ${id}`); continue; }
    given.set(id, parsed.data);
  }

  const threads: ThreadOutcome[] = manifest.threads.map((entry) => {
    const valid = new Map<string, ScoreLine>();
    for (const score of given.get(entry.threadId)?.scores ?? []) {
      const label = rubricByName(score.scorer)?.labels.find((candidate) => candidate.value === score.label);
      if (!entry.applicable.includes(score.scorer)) notes.push(`${entry.threadId}: dropped ${score.scorer}, which does not apply to a ${entry.role}`);
      else if (valid.has(score.scorer)) notes.push(`${entry.threadId}: dropped a duplicate ${score.scorer}`);
      else if (!label) notes.push(`${entry.threadId}: dropped ${score.scorer}, label "${score.label}" is not in the rubric`);
      else if (!score.reason.trim()) notes.push(`${entry.threadId}: dropped ${score.scorer}, no reason`);
      else valid.set(score.scorer, { scorer: score.scorer, label: label.value, score: label.score, reason: `${score.reason.trim()}${score.evidence.length ? ` (${score.evidence.join(", ")})` : ""}` });
    }
    const lines = entry.applicable.map((name) => valid.get(name) ?? { scorer: name, label: INSUFFICIENT, score: null, reason: entry.unavailable ? `events unavailable: ${entry.unavailable}` : "no valid judge result" });
    return { threadId: entry.threadId, role: entry.role, title: entry.title, lines, aggregate: aggregate(lines.map((line): ScoreInput => ({ scorer: line.scorer, score: line.score, label: line.label })), entry.applicable) };
  });

  const comm = data.communication;
  const handoffGiven = new Map<string, z.infer<typeof handoffResultSchema>>();
  for (const element of comm?.handoffs ?? []) {
    const parsed = handoffResultSchema.safeParse(element);
    if (!parsed.success) { if (element) notes.push("a handoff result was malformed and dropped"); continue; }
    if (!manifest.handoffs.some((entry) => entry.threadId === parsed.data.threadId)) { notes.push(`dropped a handoff result for ${parsed.data.threadId}: not a requested handoff`); continue; }
    if (handoffGiven.has(parsed.data.threadId)) { notes.push(`dropped a duplicate handoff result for ${parsed.data.threadId}`); continue; }
    handoffGiven.set(parsed.data.threadId, parsed.data);
  }
  const communication = rubricByName("communication")!;
  const handoffs: HandoffOutcome[] = manifest.handoffs.map((entry) => {
    const result = handoffGiven.get(entry.threadId);
    const label = communication.labels.find((candidate) => candidate.value === result?.label);
    // A missing side is never judged clear: the plugin forces insufficient_evidence whatever the judge said.
    const line: ScoreLine = entry.unavailable
      ? { scorer: "communication", label: INSUFFICIENT, score: null, reason: `counterpart unavailable: ${entry.unavailable}` }
      : result && label && result.reason.trim()
        ? { scorer: "communication", label: label.value, score: label.score, reason: `${result.reason.trim()}${result.evidence.length ? ` (${result.evidence.join(", ")})` : ""}` }
        : { scorer: "communication", label: INSUFFICIENT, score: null, reason: result ? "the judge's label or reason was invalid" : "no valid judge result" };
    const status = aggregate([{ scorer: "communication", score: line.score, label: line.label }], ["communication"]).status;
    return { threadId: entry.threadId, role: entry.role, line, status, signals: result?.signals ?? {}, evidence: result?.evidence ?? [], observed: entry.observed, unavailable: entry.unavailable };
  });

  const lessons: Lesson[] = [];
  const file = (raw: unknown, source: string | null, status: ThreadStatus | null) => {
    const label = typeof (raw as { rule?: unknown })?.rule === "string" ? clip((raw as { rule: string }).rule, 80) : "(malformed lesson)";
    const drop = (reason: string) => { dropped.push({ rule: label, reason }); };
    const parsed = lessonSchema.safeParse(raw);
    if (!parsed.success) return drop("malformed");
    const lesson = parsed.data;
    if (!source || status !== "fail") return drop(source ? `the source thread ${source} is ${status}, not fail` : "it cites no failing handoff");
    if (![lesson.surface, lesson.rule, lesson.missingOrWrong, lesson.prevents].every((field) => field.trim())) return drop("an empty field");
    if (lesson.existingInstruction !== null) return drop("an instruction already existed");
    if (!lesson.evidence.length || !lesson.evidence.every(refOk)) return drop("an evidence ref is not in the bundle");
    if (!(SURFACES as readonly string[]).includes(lesson.surface)) return drop(`unknown surface "${lesson.surface}"`);
    lessons.push({ sourceThread: source, surface: lesson.surface, rule: lesson.rule.trim(), missingOrWrong: lesson.missingOrWrong.trim(), prevents: lesson.prevents.trim(), recurrence: lesson.recurrence, evidence: lesson.evidence.map((ref) => ref.trim()) });
  };
  for (const outcome of threads) {
    const lesson = given.get(outcome.threadId)?.lesson;
    if (lesson != null) file(lesson, outcome.threadId, outcome.aggregate.status);
  }
  const failingHandoff = new Map(handoffs.map((handoff) => [handoff.threadId, handoff.status]));
  for (const lesson of comm?.lessons ?? []) {
    if (lesson == null) continue;
    const cited = ((lesson as { evidence?: unknown })?.evidence ?? []) as unknown;
    const ids = Array.isArray(cited) ? cited.filter((ref): ref is string => typeof ref === "string").map((ref) => ref.split("#")[0]!) : [];
    const source = ids.find((id) => failingHandoff.get(id) === "fail") ?? ids.find((id) => failingHandoff.has(id)) ?? null;
    file(lesson, source, source ? failingHandoff.get(source)! : null);
  }
  return { threads, handoffs, lessons, dropped, notes };
}

export const proposalKey = (planId: string, source: string, surface: string, rule: string) =>
  createHash("sha1").update([planId, source, surface, normalize(rule)].join("\u0000")).digest("hex");

interface RetroRow {
  plan_thread_id: string; project_id: string; chief_thread_id: string; state: string; run_id: string | null; attempts: number;
  next_at: number; started_at: number | null; last_error: string | null; path: string | null; rubric_version: string; at: number; updated_at: number;
}
interface ThreadRead {
  lines: string[];
  refs: number[];
  first: string[];
  blocks: number;
  questions: string[];
  unavailable: string | null;
}

const LOST = new Error("another collector finished this retro first");
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ⏎ ");
const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");

/** The longest head and tail of `lines` that fit `limit` characters, with a marker for the cut. */
function fit(lines: string[], limit: number): string[] {
  const size = (list: string[]) => list.reduce((total, line) => total + line.length + 1, 0);
  if (size(lines) <= limit) return lines;
  const head: string[] = [], tail: string[] = [];
  let used = 0;
  for (const line of lines) { if (used + line.length + 1 > limit / 2) break; head.push(line); used += line.length + 1; }
  used = 0;
  for (const line of [...lines].reverse()) { if (used + line.length + 1 > limit / 2 - 80) break; tail.unshift(line); used += line.length + 1; }
  return [...head, `[… ${lines.length - head.length - tail.length} lines cut to fit ${limit} characters]`, ...tail];
}

export function createRetro(ctx: Ctx) {
  const { bb, db, store } = ctx;

  async function readEvents(threadId: string): Promise<{ events: Loose[] } | { error: string }> {
    const list = (order: "asc" | "desc", cursor: Record<string, string>) => listEvents(bb, threadId, ["item/completed"], { order, limit: String(EVENT_PAGE), ...cursor });
    try {
      const head: Loose[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_HEAD_PAGES; page++) {
        const batch = await list("asc", after ? { afterSeq: after } : {});
        head.push(...batch);
        if (batch.length < EVENT_PAGE) return { events: head };
        after = String(batch.at(-1)!.seq);
      }
      // More than 3,000 events: the middle is unread, the newest 1,200 keep the end of the thread whole.
      const tail: Loose[] = [];
      let before: string | undefined;
      for (let page = 0; page < MAX_TAIL_PAGES; page++) {
        const batch = await list("desc", before ? { beforeSeq: before } : {});
        tail.push(...batch);
        if (batch.length < EVENT_PAGE) break;
        before = String(batch.at(-1)!.seq);
      }
      const seen = new Set(head.map((event) => Number(event.seq)));
      return { events: [...head, ...tail.reverse().filter((event) => !seen.has(Number(event.seq)))] };
    } catch (error) {
      return { error: clip(error instanceof Error ? error.message : String(error), 200) };
    }
  }

  /** One event as one line, or null for an item type the judge does not need. Clipping: user 1,500, agent 800, arguments 300, a failed result 500. */
  function render(event: Loose): string | null {
    const item = event.data.item as Record<string, any> | undefined;
    if (!item) return null;
    const seq = Number(event.seq);
    if (item.type === "userMessage") return `#${seq} user: ${oneLine(clip(textOf(item.content), 1_500))}`;
    if (item.type === "agentMessage") return `#${seq} agent: ${oneLine(clip(String(item.text ?? ""), 800))}`;
    if (item.type === "toolCall") {
      const failed = item.status !== "completed";
      const result = item.result == null ? (item.error ?? "[output expired]") : textOf(item.result);
      return `#${seq} tool ${item.tool}(${oneLine(clip(JSON.stringify(item.arguments ?? {}), 300))}) ${item.status}${failed ? ` -> ${oneLine(clip(String(result), 500))}` : ""}`;
    }
    if (item.type === "commandExecution") {
      const failed = item.status !== "completed";
      return `#${seq} cmd ${oneLine(clip(String(item.command ?? ""), 300))} exit=${item.exitCode ?? "?"} ${item.status}${failed ? ` -> ${oneLine(clip(item.aggregatedOutput == null ? "[output expired]" : String(item.aggregatedOutput), 500))}` : ""}`;
    }
    return null;
  }

  /** The thread's lines: first 400 and last 1,200 of what was read, plus every user message, non-completed tool call and the final chief_report call. */
  async function readThread(threadId: string, secrets: string[]): Promise<ThreadRead> {
    const read = await readEvents(threadId);
    if ("error" in read) return { lines: [`[events unavailable: ${read.error}]`], refs: [], first: [], blocks: 0, questions: [], unavailable: read.error };
    const rows = read.events.map((event) => ({ event, seq: Number(event.seq), line: render(event) })).filter((row): row is { event: Loose; seq: number; line: string } => row.line !== null);
    const lastReport = rows.map((row) => row.event.data.item).map((item, index) => ({ item, index })).filter(({ item }) => item?.type === "toolCall" && /chief_report$/.test(String(item.tool))).at(-1)?.index ?? -1;
    const kept = rows.map((row, index) => {
      const item = row.event.data.item;
      return index < HEAD_EVENTS || index >= rows.length - TAIL_EVENTS || index === lastReport || item.type === "userMessage" || ((item.type === "toolCall" || item.type === "commandExecution") && item.status !== "completed");
    });
    const lines: string[] = [];
    const refs: number[] = [];
    let previous = -1;
    rows.forEach((row, index) => {
      if (!kept[index]) return;
      if (previous >= 0 && previous !== index - 1) lines.push(`[events seq ${rows[previous]!.seq + 1}..${row.seq - 1} omitted]`);
      lines.push(scrub(row.line, secrets));
      refs.push(row.seq);
      previous = index;
    });
    const blocks = rows.filter((row) => row.event.data.item.type === "toolCall" && /chief_report$/.test(String(row.event.data.item.tool)) && row.event.data.item.arguments?.state === "blocked").length;
    const questions = rows.filter((row) => (row.event.data.item.type === "toolCall" && /chief_report$/.test(String(row.event.data.item.tool)) && row.event.data.item.arguments?.state === "blocked")
      || (row.event.data.item.type === "agentMessage" && /\?\s*$/.test(String(row.event.data.item.text ?? "")))).map((row) => scrub(row.line, secrets));
    return { lines, refs, first: rows.slice(0, 40).map((row) => scrub(row.line, secrets)), blocks, questions, unavailable: null };
  }

  /** Chief's own events between the planner's start and completion that carry a handoff: the user's words, chief_* calls and `bb thread tell` naming a plan thread. */
  async function readChiefWindow(chief: string, from: number, to: number, ids: string[], secrets: string[]): Promise<{ lines: string[]; refs: number[]; unavailable: string | null }> {
    let found: Loose[];
    try {
      found = await recentEvents(bb, chief, ["item/completed"], { since: from, until: to + 1, pages: MAX_HEAD_PAGES });
    } catch (error) {
      return { lines: [`[events unavailable: ${clip(String(error), 200)}]`], refs: [], unavailable: clip(error instanceof Error ? error.message : String(error), 200) };
    }
    const names = (text: string) => ids.some((id) => text.includes(id));
    const lines: string[] = [];
    const refs: number[] = [];
    for (const event of found.reverse()) {
      const item = event.data.item as Record<string, any> | undefined;
      if (!item) continue;
      const user = item.type === "userMessage" ? textOf(item.content) : "";
      const keep = item.type === "userMessage" ? !/^\s*(\[Chief lifecycle alert\]|\[bb message from thread:)/.test(user)
        : item.type === "toolCall" ? /chief_/.test(String(item.tool)) && names(JSON.stringify(item.arguments ?? {}))
        : item.type === "commandExecution" ? /bb thread tell/.test(String(item.command)) && names(String(item.command)) : false;
      const line = keep ? render(event) : null;
      if (!line) continue;
      lines.push(scrub(line, secrets));
      refs.push(Number(event.seq));
    }
    return { lines, refs, unavailable: null };
  }

  async function providerSummary(row: ManagedRow): Promise<string> {
    try {
      const live = await bb.sdk.threads.get({ threadId: row.thread_id });
      if (live.providerId !== "agy") return `provider: ${live.providerId ?? "unknown"} (no step summary)`;
      const id = await providerThreadId(bb, row.thread_id);
      if (!id) return "provider: agy (no conversation id)";
      const history = await readAgySteps(agyDbPath(id), RECENT_STEPS, true);
      if (history.status !== "ok") return `provider: agy (${history.note})`;
      return `provider: agy, ${history.steps.length} newest steps, ${history.steps.filter((step) => failedStatus(step.status)).length} failed`;
    } catch {
      return "provider: unavailable";
    }
  }

  /** The threads the judge scores: the planner, the plan's rows and their reviewers; failures first, then one per role, at most 8. */
  function sample(planner: ManagedRow) {
    const rows = store.all();
    const members = new Map<string, ManagedRow>([[planner.thread_id, planner]]);
    for (const row of rows) if (row.plan_thread_id === planner.thread_id && (row.role === "worker" || row.role === "advisor")) members.set(row.thread_id, row);
    for (const row of rows) if (row.role === "reviewer" && row.worker_thread_id && members.has(row.worker_thread_id)) members.set(row.thread_id, row);
    const all = [...members.values()].sort((a, b) => a.created_at - b.created_at);
    const ids = all.map((row) => row.thread_id);
    const flagged = new Set((db.prepare(`SELECT DISTINCT thread_id FROM chief_events WHERE thread_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { thread_id: string }[]).map((row) => row.thread_id));
    const picked: ManagedRow[] = all.filter((row) => flagged.has(row.thread_id) || row.state === "blocked" || row.reject_streak > 0);
    for (const row of all) if (!picked.some((other) => other.role === row.role && (other.kind ?? null) === (row.kind ?? null))) picked.push(row);
    for (const row of all) if (!picked.includes(row)) picked.push(row);
    const chosen = picked.slice(0, MAX_THREADS);
    return { chosen, dropped: picked.slice(MAX_THREADS).map((row) => `${row.thread_id} ${row.role} “${clip(row.title, 60)}”`) };
  }

  /** Writes the bundle as Chief artifacts retro/<planId>/… and returns the manifest and the judge jobs. Evidence comes from artifacts and chief_completions, never the child's storage. */
  async function collectRetroBundle(planner: ManagedRow) {
    const secrets = await configuredSecrets(ctx);
    const planId = planner.thread_id;
    const chiefId = planner.chief_thread_id!;
    const dir = `retro/${planId}`;
    const write = (name: string, text: string) => ctx.writeArtifact(chiefId, planner.project_id, `${dir}/${name}`, text);
    const { chosen, dropped } = sample(planner);
    const refs: Record<string, number[]> = {};
    const manifest: Manifest = { version: RUBRIC_VERSION, planId, title: planner.title, chiefThreadId: chiefId, projectId: planner.project_id, threads: [], handoffs: [], handoffFile: null, refs, dropped };
    const briefs = new Map<string, string | null>();
    const reads = new Map<string, ThreadRead>();
    const scrubbed = (text: string) => scrub(text, secrets);

    for (const row of chosen) {
      const read = await readThread(row.thread_id, secrets);
      reads.set(row.thread_id, read);
      const brief = (await ctx.readArtifact(row.thread_id, row.project_id, "brief.md"))?.text || null;
      briefs.set(row.thread_id, brief);
      const completion = db.prepare(`SELECT pr_url, head_sha, diff_state, diff_note FROM chief_completions WHERE thread_id=?`).get(row.thread_id) as { pr_url: string | null; head_sha: string | null; diff_state: string; diff_note: string | null } | undefined;
      const diff = completion ? (await ctx.readArtifact(row.thread_id, row.project_id, "completion.diff"))?.text || null : null;
      const stat = diff ? `${(diff.match(/^diff --git /gm) ?? []).length} files, +${(diff.match(/^\+(?!\+\+)/gm) ?? []).length} -${(diff.match(/^-(?!--)/gm) ?? []).length}` : null;
      const observed = db.prepare(`SELECT kind, detail, at FROM chief_events WHERE thread_id=? ORDER BY at`).all(row.thread_id) as { kind: string; detail: string | null; at: number }[];
      const applicable = applicableRubrics(row.role === "worker" ? row.kind : null);
      const text = [
        `# Thread ${row.thread_id}: ${row.role}${row.kind ? `/${row.kind}` : ""} “${scrubbed(row.title)}”`,
        `state ${row.state}; created ${new Date(row.created_at).toISOString()}; updated ${new Date(row.updated_at).toISOString()}; reject_streak ${row.reject_streak}`,
        `Applicable rubrics: ${applicable.join(", ")}`,
        await providerSummary(row),
        "", "## Brief (artifact brief.md)", brief ? scrubbed(clip(brief, 12_000)) : "[brief artifact missing]",
        "", "## Completion evidence (chief_completions)",
        completion ? `PR ${completion.pr_url ?? "none"}; head ${completion.head_sha ?? "unknown"}; diff ${completion.diff_state}${completion.diff_note ? ` (${scrubbed(clip(completion.diff_note, 200))})` : ""}${stat ? `; ${stat}` : ""}` : "none recorded",
        ...(diff ? ["```diff", scrubbed(clip(diff, 5_000)), "```"] : []),
        "", "## Observed events (chief_events)",
        ...(observed.length ? observed.slice(0, 40).map((event) => `- ${new Date(event.at).toISOString()} ${event.kind}${event.detail ? `: ${scrubbed(event.detail)}` : ""}`) : ["none"]),
        "", "## Events (each line starts with #<seq>; cite it as " + row.thread_id + "#<seq>)",
      ];
      const events = fit(read.lines, 100_000);
      refs[row.thread_id] = [...(events.join("\n").matchAll(/^#(\d+) /gm))].map((match) => Number(match[1]));
      const file = await write(`thread-${row.thread_id}.md`, [...text, ...events, ""].join("\n"));
      manifest.threads.push({ threadId: row.thread_id, role: row.role, kind: row.kind, title: row.title, file, applicable, unavailable: read.unavailable });
    }

    // Handoffs: the same sampled threads, each against Chief's side of the conversation.
    const planned = [planner.thread_id, ...chosen.map((row) => row.thread_id)];
    const chief = await readChiefWindow(chiefId, planner.created_at, planner.updated_at, planned, secrets);
    const parts: string[] = [`# Handoffs for plan ${planId}: “${scrubbed(planner.title)}”`, "Observed counts are computed by the plugin from stored rows and events. Tokens are an estimate (characters / 4).", ""];
    for (const row of chosen) {
      const read = reads.get(row.thread_id)!;
      const brief = briefs.get(row.thread_id) ?? null;
      const reviewers = store.all().filter((other) => other.role === "reviewer" && other.worker_thread_id === row.thread_id).map((other) => other.thread_id);
      const scope = [row.thread_id, ...reviewers];
      const marks = scope.map(() => "?").join(",");
      const count = (kind: string) => (db.prepare(`SELECT COUNT(*) n FROM chief_events WHERE kind=? AND thread_id IN (${marks})`).get(kind, ...scope) as { n: number }).n;
      const alerts = db.prepare(`SELECT message, created_at FROM alert_outbox WHERE source_thread_id=? ORDER BY created_at`).all(row.thread_id) as { message: string; created_at: number }[];
      const alertChars = alerts.reduce((total, alert) => total + alert.message.length, 0);
      const observed: Observed = { nudges: count("nudge"), blocks: read.blocks, reviewRounds: count("request_changes"), briefChars: brief ? brief.length : null, alertChars, estTokens: brief ? Math.ceil((brief.length + alertChars) / 4) : null };
      const unavailable = [!brief ? "the brief artifact is missing" : null, read.unavailable ? `the child's events are unavailable (${read.unavailable})` : null, chief.unavailable ? `Chief's events are unavailable (${chief.unavailable})` : null].filter(Boolean).join("; ") || null;
      const findings = [row, ...scope.slice(1).map((id) => store.get(id)).filter((other): other is ManagedRow => !!other)].filter((other) => other.findings).map((other) => `${other.thread_id}: ${clip(other.findings!, 1_500)}`);
      const eventLines = [...read.first, ...read.questions].map((line) => `${row.thread_id}${line}`);
      parts.push(`## Handoff ${row.thread_id}: ${row.role}${row.kind ? `/${row.kind}` : ""} “${scrubbed(clip(row.title, 80))}”`,
        unavailable ? `counterpart unavailable: ${unavailable}` : "counterpart available",
        `Observed: nudges ${observed.nudges}; blocks ${observed.blocks}; review rounds ${observed.reviewRounds}; brief chars ${observed.briefChars ?? "unknown"}; alert chars ${alertChars}; tokens ${observed.estTokens ?? "unknown"} (estimate)`,
        "### Brief sent", brief ? scrubbed(clip(brief, 6_000)) : "[brief artifact missing]",
        "### Child's first events and every question or blocked report",
        ...eventLines.map((line) => line.replace(/^(thr_\w+)#/, "$1#")),
        "### Alerts from the child to Chief", ...(alerts.length ? alerts.map((alert) => `- ${new Date(alert.created_at).toISOString()} ${scrubbed(oneLine(clip(alert.message, 800)))}`) : ["none"]),
        "### Review findings", ...(findings.length ? findings.map(scrubbed) : ["none"]), "");
      manifest.handoffs.push({ threadId: row.thread_id, role: row.role, title: row.title, unavailable, observed });
    }
    parts.push("## Chief's side: the user's words, chief_* calls and bb thread tell naming these threads", ...chief.lines.map((line) => `${chiefId}${line}`), "");
    // Chief-side refs are cited as <chiefThreadId>#<seq>; the child-side lines above were prefixed with the child id.
    const handoffLines = fit(parts.join("\n").split("\n"), FILE_CHARS);
    // Only refs still visible as a `<thread>#<seq> ` line start in handoffs.md count for the handoff file; per-thread refs stay as written.
    const visible = new Map<string, number[]>();
    for (const match of handoffLines.join("\n").matchAll(/^(thr_\w+)#(\d+) /gm)) visible.set(match[1]!, [...(visible.get(match[1]!) ?? []), Number(match[2])]);
    for (const [id, seqs] of visible) refs[id] = [...new Set([...(refs[id] ?? []), ...seqs])];
    manifest.handoffFile = await write("handoffs.md", handoffLines.join("\n"));
    await write("manifest.json", JSON.stringify(manifest));

    const preamble = `READ-ONLY: ${READ_ONLY}, and run no command that changes tracked files or git state. You only read the bundle files named below and judge them; the files are your whole evidence.`;
    const filing = `Filing a lesson: return lesson null unless ALL four hold: (1) an instruction is missing or wrong on a nameable surface (one of: ${SURFACES.join(", ")}); (2) it is one reusable rule; (3) following it would have prevented the failure; (4) it recurs or is severe. Do not file when the instruction existed and was ignored (then set existingInstruction to it and the plugin drops the lesson), for variance, for restating a rule, or when the fix is code or infrastructure. No change is a success. Cite evidence only as <threadId>#<seq> from the bundle.`;
    const jobs: { kind: "thread" | "communication"; prompt: string }[] = manifest.threads.map((entry) => ({
      kind: "thread",
      prompt: [
        `Score thread ${entry.threadId} (${entry.role}${entry.kind ? `/${entry.kind}` : ""}). Read ${entry.file} in full.`,
        `Return threadId exactly "${entry.threadId}", and one score for each of: ${entry.applicable.join(", ")}. Use only labels from the rubric; use ${INSUFFICIENT} when the bundle cannot support a judgment and ${NOT_APPLICABLE} when a rubric does not apply.`,
        "Every reason is 1–3 sentences citing specifics as <threadId>#<seq>. A claim with no cited moment is not evidence.",
        filing, "", ...entry.applicable.map((name) => renderRubric(rubricByName(name)!)),
      ].join("\n"),
    }));
    if (manifest.handoffs.length) {
      jobs.push({
        kind: "communication",
        prompt: [
          `Score the Chief↔child handoffs. Read ${manifest.handoffFile} in full. Handoff thread ids: ${manifest.handoffs.map((handoff) => handoff.threadId).join(", ")}. Return one result per handoff, with threadId exactly as listed.`,
          `A handoff marked "counterpart unavailable" gets ${INSUFFICIENT}. Observed counts in the file are computed by the plugin: do not recompute them; set the signals (briefGapBlock, askedTwice, unclearBriefRounds, userWordsLost) true, false or null (unknown) from the evidence. Cite both sides as <threadId>#<seq>.`,
          filing, "", renderRubric(RUBRICS.find((rubric) => rubric.name === "communication")!),
        ].join("\n"),
      });
    }
    return { manifest, jobs, preamble };
  }

  // ---- the state machine -------------------------------------------------

  async function judgeModel(chiefId: string) {
    try {
      const live = await bb.sdk.threads.get({ threadId: chiefId });
      const hostId = live.environmentId ? await ctx.environmentHostId(live.environmentId) : null;
      const stored = hostId ? ctx.readResearchModel(hostId, "investigate") : null;
      const usable = stored && hostId ? await ctx.usableSelection(hostId, stored, ctx.catalogReader(hostId)) : null;
      return usable ? { provider: usable.providerId, model: usable.model, reasoningLevel: usable.reasoningLevel } : {};
    } catch {
      return {};
    }
  }

  function claim(now: number) {
    const since = Number((db.prepare(`SELECT value FROM plugin_meta WHERE key='retros_since'`).get() as { value: string } | undefined)?.value ?? now);
    const rows = store.all();
    const insert = db.prepare(`INSERT OR IGNORE INTO chief_retros (plan_thread_id, project_id, chief_thread_id, state, attempts, next_at, rubric_version, at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`);
    for (const planner of rows) {
      if (planner.role !== "planner" || planner.state !== "complete" || planner.updated_at < since || !planner.chief_thread_id) continue;
      if (rows.some((other) => other.role === "planner" && other.replaces_thread_id === planner.thread_id)) continue; // superseded: its waves never ran
      if (!rows.some((other) => other.plan_thread_id === planner.thread_id && other.role === "worker" && other.state === "complete")) continue;
      if (!ctx.isActiveChief(store.get(planner.chief_thread_id))) continue;
      insert.run(planner.thread_id, planner.project_id, planner.chief_thread_id, now, RUBRIC_VERSION, now, now);
    }
  }

  /** Back to pending for another try, or failed (with one alert) at the third attempt. Guarded: only the owner of this run id moves the row. */
  async function settle(row: RetroRow, reason: string, now: number) {
    const failed = row.attempts >= MAX_ATTEMPTS;
    const changed = db.prepare(`UPDATE chief_retros SET state=?, run_id=NULL, next_at=?, last_error=?, updated_at=? WHERE plan_thread_id=? AND state=? AND run_id IS ?`)
      .run(failed ? "failed" : "pending", now + RETRY_MS, clip(reason, 500), now, row.plan_thread_id, row.state, row.run_id).changes;
    if (failed && changed === 1) {
      const title = store.get(row.plan_thread_id)?.title ?? row.plan_thread_id;
      await ctx.alertSelf(row.chief_thread_id, `retro-failed:${row.plan_thread_id}`, `Retro for plan “${title}” failed after ${row.attempts} attempts: ${clip(reason, 300)}\nNo scores were stored. Nothing else to do unless you want the plan graded by hand.`).catch((error) => bb.log.warn(`Could not alert the retro failure: ${String(error)}`));
    }
  }

  async function start(now: number) {
    const due = db.prepare(`SELECT * FROM chief_retros WHERE state='pending' AND next_at<=? ORDER BY next_at LIMIT ?`).all(now, MAX_STARTS) as RetroRow[];
    for (const row of due) {
      if (!ctx.isActiveChief(store.get(row.chief_thread_id))) continue;
      // The lease (next_at) and the guard make the claim exclusive: a second claimer changes 0 rows.
      const claimed = db.prepare(`UPDATE chief_retros SET attempts=attempts+1, started_at=?, run_id=NULL, next_at=?, updated_at=? WHERE plan_thread_id=? AND state='pending' AND next_at<=?`)
        .run(now, now + RETRY_MS, now, row.plan_thread_id, now).changes === 1;
      if (!claimed) continue;
      const current = { ...row, attempts: row.attempts + 1 };
      try {
        const planner = store.get(row.plan_thread_id);
        if (!planner) throw new Error("the planner row is gone");
        const { jobs, preamble } = await collectRetroBundle(planner);
        const args = { preamble, jobs, cap: MAX_THREADS + 1, models: { judge: await judgeModel(row.chief_thread_id) } };
        const started = await ctx.runWorkflowCli("run", ["--script", RETRO_SCRIPT, "--args", JSON.stringify(args)], { threadId: row.chief_thread_id, projectId: row.project_id });
        if (typeof started?.runId !== "string") throw new Error("bb workflows run returned no runId");
        db.prepare(`UPDATE chief_retros SET state='running', run_id=?, last_error=NULL, updated_at=? WHERE plan_thread_id=? AND state='pending' AND run_id IS NULL`).run(started.runId, Date.now(), row.plan_thread_id);
      } catch (error) {
        await settle(current, `could not start: ${error instanceof Error ? error.message : String(error)}`, now);
      }
    }
  }

  async function poll(now: number) {
    const running = db.prepare(`SELECT * FROM chief_retros WHERE state='running'`).all() as RetroRow[];
    for (const row of running) {
      const target = { threadId: row.chief_thread_id, projectId: row.project_id };
      const overdue = now - (row.started_at ?? row.at) > RUN_TIMEOUT_MS;
      let run: { status: string; result?: unknown; resultOmitted?: boolean; error?: unknown };
      try {
        run = await ctx.runWorkflowCli("status", [row.run_id!], target);
      } catch (error) {
        const reason = clip(error instanceof Error ? error.message : String(error), 300);
        if (overdue) { await ctx.runWorkflowCli("stop", [row.run_id!], target).catch(() => undefined); await settle(row, `timed out after 2 h; status unreadable (${reason})`, now); }
        else db.prepare(`UPDATE chief_retros SET last_error=?, updated_at=? WHERE plan_thread_id=? AND state='running' AND run_id=?`).run(`status unreadable: ${reason}`, now, row.plan_thread_id, row.run_id);
        continue;
      }
      if (RUNNING_RUN.has(run.status)) {
        if (overdue) { await ctx.runWorkflowCli("stop", [row.run_id!], target).catch(() => undefined); await settle(row, "timed out after 2 h", now); }
        continue;
      }
      if (run.status !== "succeeded") { await settle(row, `run ${run.status}: ${clip(JSON.stringify(run.error ?? ""), 300)}`, now); continue; }
      try {
        await collect(row, run);
      } catch (error) {
        // retro.md or the database failed: the row stays running and the next tick retries, inside the 2 h bound.
        const reason = clip(error instanceof Error ? error.message : String(error), 300);
        bb.log.warn(`Retro collect for ${row.plan_thread_id} failed: ${reason}`);
        db.prepare(`UPDATE chief_retros SET last_error=?, updated_at=? WHERE plan_thread_id=? AND state='running' AND run_id=?`).run(`collect failed: ${reason}`, now, row.plan_thread_id, row.run_id);
      }
    }
  }

  /** Validates, writes retro.md, then stores scores, proposed lessons, the done state and the alert in one transaction. Safe to run twice on one run. */
  async function collect(row: RetroRow, run: { result?: unknown; resultOmitted?: boolean }) {
    const target = { threadId: row.chief_thread_id, projectId: row.project_id };
    const manifestText = (await ctx.readArtifact(row.chief_thread_id, row.project_id, `retro/${row.plan_thread_id}/manifest.json`))?.text;
    let manifest: Manifest | null = null;
    try { manifest = manifestText ? JSON.parse(manifestText) as Manifest : null; } catch { manifest = null; }
    if (!manifest) return settle(row, "the bundle manifest is missing or unreadable, so the result cannot be validated", Date.now());
    let result = run.result;
    if (run.resultOmitted) {
      const history: unknown = await ctx.runWorkflowCli("history", [row.run_id!, "--cursor", "0", "--limit", "1"], target);
      result = (Array.isArray(history) ? history : [history]).find((line) => line?.type === "run")?.result;
    }
    const evaluation = evaluate(result, manifest);
    const secrets = await configuredSecrets(ctx);
    const clean = (text: string) => scrub(text, secrets);
    const sentry = await sentryIssuesForTag(ctx, "plan_thread_id", row.plan_thread_id, 14).then((issues) => issues, () => undefined);
    const markdown = clean(renderRetro(row, manifest, evaluation, sentry, db));
    const path = await ctx.writeArtifact(row.chief_thread_id, row.project_id, `retro/${row.plan_thread_id}/retro.md`, markdown);
    const failedThreads = evaluation.threads.filter((outcome) => outcome.aggregate.status === "fail").length;
    const insufficient = evaluation.threads.filter((outcome) => outcome.aggregate.status === "insufficient").length;
    const alert = `Retro for plan “${manifest.title}”: ${path}. ${failedThreads}/${evaluation.threads.length} threads failed, ${insufficient} insufficient. ${evaluation.lessons.length} proposed lessons (bb chief lessons --status proposed; accept or retire with a reason).`;
    const now = Date.now();
    const upsert = db.prepare(`INSERT INTO chief_scores (thread_id, plan_thread_id, role, scorer, rubric_version, label, score, reason, at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, scorer, rubric_version) DO UPDATE SET plan_thread_id=excluded.plan_thread_id, role=excluded.role, label=excluded.label, score=excluded.score, reason=excluded.reason, detail=excluded.detail`);
    const lesson = db.prepare(`INSERT OR IGNORE INTO chief_lessons (project_id, text, source_thread_id, worker_thread_id, at, role, status, surface, plan_thread_id, evidence, rubric_version, proposal_key) VALUES (?, ?, ?, NULL, ?, ?, 'proposed', ?, ?, ?, ?, ?)`);
    try {
      db.transaction(() => {
        for (const outcome of evaluation.threads) for (const line of outcome.lines) upsert.run(outcome.threadId, row.plan_thread_id, outcome.role, line.scorer, manifest.version, line.label, line.score, clean(line.reason), now, null);
        for (const handoff of evaluation.handoffs) upsert.run(handoff.threadId, row.plan_thread_id, handoff.role, handoff.line.scorer, manifest.version, handoff.line.label, handoff.line.score, clean(handoff.line.reason), now, JSON.stringify({ observed: handoff.observed, signals: handoff.signals }));
        for (const item of evaluation.lessons) {
          lesson.run(row.project_id, clean(clip(item.rule, 400)), item.sourceThread, now, lessonRole(item.surface), item.surface, row.plan_thread_id,
            clean(JSON.stringify({ refs: item.evidence, missingOrWrong: item.missingOrWrong, prevents: item.prevents, recurrence: item.recurrence })), manifest.version,
            proposalKey(row.plan_thread_id, item.sourceThread, item.surface, item.rule));
        }
        const done = db.prepare(`UPDATE chief_retros SET state='done', path=?, last_error=NULL, updated_at=? WHERE plan_thread_id=? AND state='running' AND run_id=?`).run(path, now, row.plan_thread_id, row.run_id).changes;
        if (done !== 1) throw LOST;
        ctx.insertAlert(row.chief_thread_id, row.chief_thread_id, `${row.chief_thread_id}:retro:${row.plan_thread_id}`, alert);
      })();
    } catch (error) {
      if (error === LOST) return;
      throw error;
    }
    await ctx.deliverAlert(`${row.chief_thread_id}:retro:${row.plan_thread_id}`).catch((error) => bb.log.warn(`Could not deliver the retro alert: ${String(error)}`));
  }

  /** One pass: claim eligible plans, poll running rows, start due ones. Overlapping calls share one pass; the retroJudge setting turns it all off. */
  function retroTick(now: number): Promise<void> {
    if (ctx.state.retroing) return ctx.state.retroing;
    const pass = (async () => {
      try {
        if (!(await ctx.settings.get()).retroJudge) return;
        claim(now);
        await poll(now);
        await start(now);
      } catch (error) {
        bb.log.warn(`Retro tick failed: ${String(error)}`);
      } finally {
        ctx.state.retroing = null;
      }
    })();
    ctx.state.retroing = pass;
    return pass;
  }

  return { retroTick, collectRetroBundle };
}


/** retro.md: both tables, the reasons, Sentry, the plan's ledger summary, completion evidence and the lessons filed and dropped. */
function renderRetro(row: RetroRow, manifest: Manifest, evaluation: Evaluation, sentry: Awaited<ReturnType<typeof sentryIssuesForTag>> | undefined, db: Ctx["db"]): string {
  const scorers = [...new Set(evaluation.threads.flatMap((outcome) => outcome.lines.map((line) => line.scorer)))];
  const shown = (outcome: ThreadOutcome, scorer: string) => { const line = outcome.lines.find((entry) => entry.scorer === scorer); return line ? `${line.label}${line.score === null ? "" : ` (${line.score})`}` : "-"; };
  const events = db.prepare(`SELECT kind, COUNT(*) n FROM chief_events WHERE plan_thread_id=? GROUP BY kind ORDER BY n DESC`).all(row.plan_thread_id) as { kind: string; n: number }[];
  const completions = db.prepare(`SELECT thread_id, diff_state FROM chief_completions WHERE plan_thread_id=?`).all(row.plan_thread_id) as { thread_id: string; diff_state: string }[];
  return [
    `# Retro: ${manifest.title}`,
    `Plan ${manifest.planId}; rubric ${manifest.version}; run ${row.run_id}; attempt ${row.attempts}.`,
    "", "## Threads",
    `| thread | role | ${scorers.join(" | ")} | overall | status |`, `| --- | --- | ${scorers.map(() => "---").join(" | ")} | --- | --- |`,
    ...evaluation.threads.map((outcome) => `| ${outcome.threadId} | ${cell(outcome.role)} | ${scorers.map((scorer) => cell(shown(outcome, scorer))).join(" | ")} | ${outcome.aggregate.overall === null ? "-" : outcome.aggregate.overall.toFixed(4)} | ${outcome.aggregate.status} |`),
    "", "## Communication (handoffs)",
    "| handoff | label | observed (plugin) | judge-attributed signals | evidence |", "| --- | --- | --- | --- | --- |",
    ...evaluation.handoffs.map((handoff) => `| ${handoff.threadId} | ${handoff.line.label}${handoff.line.score === null ? "" : ` (${handoff.line.score})`} | nudges ${handoff.observed.nudges}, blocks ${handoff.observed.blocks}, review rounds ${handoff.observed.reviewRounds}, brief ${handoff.observed.briefChars ?? "?"} chars, alerts ${handoff.observed.alertChars} chars, ~${handoff.observed.estTokens ?? "?"} tokens (estimate) | ${cell(Object.entries(handoff.signals).map(([name, value]) => `${name}=${value}`).join(", ") || "none")} | ${cell(handoff.evidence.join(", "))} |`),
    "", "## Reasons",
    ...evaluation.threads.flatMap((outcome) => outcome.lines.map((line) => `- ${outcome.threadId} ${line.scorer} (${line.label}): ${line.reason}`)),
    ...evaluation.handoffs.map((handoff) => `- ${handoff.threadId} communication (${handoff.line.label}): ${handoff.line.reason}`),
    "", "## Sampling", `${evaluation.threads.length} threads judged${manifest.dropped.length ? `; not judged (cap ${MAX_THREADS}): ${manifest.dropped.join("; ")}` : ""}.`,
    ...(evaluation.notes.length ? ["", "## Judge result notes", ...evaluation.notes.map((note) => `- ${note}`)] : []),
    "", "## Sentry issues tagged plan_thread_id",
    sentry === undefined ? "Not available: the Sentry read failed." : sentry === null ? "Not configured." : sentry.length ? sentry.map((issue) => `- ${issue.shortId} [${issue.level}] ${issue.title} ${issue.permalink}`).join("\n") : "None.",
    "", "## Plan events (chief_events)", ...(events.length ? events.map((event) => `- ${event.kind}: ${event.n}`) : ["None."]),
    "", "## Completion evidence", ...(completions.length ? completions.map((entry) => `- ${entry.thread_id}: diff ${entry.diff_state}`) : ["None recorded."]),
    "", "## Proposed lessons (bb chief lessons --status proposed)",
    ...(evaluation.lessons.length ? evaluation.lessons.map((item) => `- [${item.surface}] ${item.rule} — missing or wrong: ${item.missingOrWrong}; prevents: ${item.prevents}; ${item.recurrence}; from ${item.sourceThread}; evidence ${item.evidence.join(", ")}`) : ["None."]),
    "", "## Dropped lessons", ...(evaluation.dropped.length ? evaluation.dropped.map((item) => `- ${item.rule}: ${item.reason}`) : ["None."]),
    "",
  ].join("\n");
}
