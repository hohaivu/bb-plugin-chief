import { clip } from "../core/text";
import type { Ctx } from "../runtime/context";
import { normalize, scrub } from "./scrub";
import { ACTIVITY_KINDS, ADAPTERS, type Adapter, collectSources, configuredSecrets, type Item, type Section } from "./sources";

export const REPORT_MAX_CHARS = 60_000;
export const LEDGER_RETENTION_MS = 90 * 86_400_000;
const DAY_MS = 86_400_000;
const TRIAGE = "Triage: read the report, then plan any fix as normal work (chief_plan).";

interface Block { title: string; lines: string[]; cut: number }
export interface DailyCounts { newSentry: number; patterns: number; blocked: number; stalls: number; reviewRounds: number }

const pad = (value: number) => String(value).padStart(2, "0");
/** The server-local date, the one the 08:00 schedule runs on. */
export const localDate = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const line = (item: Item) => `- ${item.count && item.count > 1 ? `${item.count}× ` : ""}${item.kind}: ${item.text}${item.threadId ? ` (${item.threadId})` : ""}`;

/** The report as one markdown string, at most 60,000 characters: when over, whole items go from the end of the longest section. */
export async function buildDailyReport(ctx: Ctx, since: number, until: number, adapters: Record<string, Adapter> = ADAPTERS): Promise<{ markdown: string; counts: DailyCounts; sections: Section[] }> {
  const sections = await collectSources(ctx, since, until, adapters);
  const secrets = await configuredSecrets(ctx);
  const { db, store } = ctx;
  const itemsOf = (name: string) => sections.find((section) => section.name === name)?.items ?? [];
  const failureItems = sections.flatMap((section) => section.items).filter((item) => !ACTIVITY_KINDS.has(item.kind) && item.kind !== "compaction" && item.kind !== "new" && item.kind !== "recurring");

  const blocks: Block[] = [];
  const block = (title: string, lines: string[]) => { blocks.push({ title, lines, cut: 0 }); return lines; };

  block("Sources", ["| Source | Status | Items | Note |", "| --- | --- | --- | --- |",
    ...sections.map((section) => `| ${section.name} | ${section.status} | ${section.items.length} | ${(section.note ?? "").replace(/\|/g, "/")} |`)]);

  const sentry = sections.find((section) => section.name === "sentry");
  const newIssues = itemsOf("sentry").filter((item) => item.kind === "new");
  const recurringIssues = itemsOf("sentry").filter((item) => item.kind === "recurring");
  block("Sentry", sentry && sentry.status !== "ok" ? [`Not available: ${sentry.status}${sentry.note ? ` — ${sentry.note}` : ""}`] : [
    `New (first seen in the window): ${newIssues.length}`, ...newIssues.map(line),
    `Recurring (seen before the window): ${recurringIssues.length}`, ...recurringIssues.map(line),
  ]);

  const countsByKind = (from: number, to: number) => new Map((db.prepare(`SELECT kind, COUNT(*) n FROM chief_events WHERE at >= ? AND at < ? GROUP BY kind`).all(from, to) as { kind: string; n: number }[]).map((row) => [row.kind, row.n]));
  const now = countsByKind(since, until), before = countsByKind(since - (until - since), since);
  const rounds = (from: number, to: number) => {
    const best = new Map<string, number>();
    for (const row of db.prepare(`SELECT thread_id, detail FROM chief_events WHERE kind='request_changes' AND at >= ? AND at < ?`).all(from, to) as { thread_id: string | null; detail: string | null }[]) {
      const round = Number(/round=(\d+)/.exec(row.detail ?? "")?.[1]);
      if (row.thread_id && round > (best.get(row.thread_id) ?? 0)) best.set(row.thread_id, round);
    }
    return best;
  };
  const roundsNow = rounds(since, until), roundsBefore = rounds(since - (until - since), since);
  const rounds2 = (best: Map<string, number>) => [...best.values()].filter((round) => round >= 2).length;
  const kinds = [...new Set([...now.keys(), ...before.keys()])].sort();
  const blocked = store.all().filter((row) => row.state === "blocked").length;
  const stalls = (now.get("stall") ?? 0) + (now.get("hard_stall") ?? 0);
  block("Scorecard (24 h vs previous 24 h)", ["| Metric | Last 24 h | Previous 24 h |", "| --- | --- | --- |",
    ...kinds.map((kind) => `| ${kind} | ${now.get(kind) ?? 0} | ${before.get(kind) ?? 0} |`),
    `| tasks with review round ≥ 2 | ${rounds2(roundsNow)} | ${rounds2(roundsBefore)} |`,
    `| highest review round of one task | ${Math.max(0, ...roundsNow.values())} | ${Math.max(0, ...roundsBefore.values())} |`,
    `| workers blocked now | ${blocked} | |`]);

  const completions = db.prepare(`SELECT thread_id, pr_url, diff_state, diff_note FROM chief_completions WHERE at >= ? AND at < ? ORDER BY at`).all(since, until) as { thread_id: string; pr_url: string | null; diff_state: string; diff_note: string | null }[];
  const lacking = completions.filter((row) => row.diff_state !== "ok");
  block("Completion evidence", [`${completions.length} workers completed; ${lacking.length} without a whole diff.`,
    ...lacking.map((row) => `- ${row.thread_id} ${row.diff_state}${row.pr_url ? ` ${row.pr_url}` : ""}: ${clip(row.diff_note ?? "", 300)}`)]);

  const patterns = new Map<string, { kind: string; text: string; count: number }>();
  for (const item of failureItems) {
    const key = `${item.kind}\u0000${normalize(item.text)}`;
    const found = patterns.get(key);
    if (found) found.count += item.count ?? 1;
    else patterns.set(key, { kind: item.kind, text: item.text, count: item.count ?? 1 });
  }
  const recurring = [...patterns.values()].filter((pattern) => pattern.count >= 2).sort((a, b) => b.count - a.count);
  block("Recurring patterns", recurring.slice(0, 15).map((pattern) => `- ${pattern.count}× ${pattern.kind}: ${pattern.text}`));

  const perThread = new Map<string, Map<string, number>>();
  for (const item of failureItems) {
    if (!item.threadId) continue;
    const kindsOf = perThread.get(item.threadId) ?? new Map<string, number>();
    kindsOf.set(item.kind, (kindsOf.get(item.kind) ?? 0) + (item.count ?? 1));
    perThread.set(item.threadId, kindsOf);
  }
  const total = (kindsOf: Map<string, number>) => [...kindsOf.values()].reduce((a, b) => a + b, 0);
  block("Threads with failures", [...perThread].sort((a, b) => total(b[1]) - total(a[1])).slice(0, 30).map(([threadId, kindsOf]) => {
    const row = store.get(threadId);
    return `- ${threadId}${row ? ` ${row.role} “${clip(row.title, 80)}”` : ""}: ${[...kindsOf].map(([kind, n]) => `${kind}×${n}`).join(", ")}`;
  }));

  block("Logs", itemsOf("bbLogs").map(line));

  const render = () => [
    `# Daily Chief report ${localDate(until)}`, `Window: ${new Date(since).toISOString()} to ${new Date(until).toISOString()}`, "",
    ...blocks.flatMap((b) => [`## ${b.title}`, ...(b.lines.length ? b.lines : ["None."]), ...(b.cut ? [`…${b.cut} more cut to fit ${REPORT_MAX_CHARS} characters`] : []), ""]),
    TRIAGE,
  ].join("\n");
  let markdown = scrub(render(), secrets);
  while (markdown.length > REPORT_MAX_CHARS) {
    const longest = blocks.reduce((best, current) => current.lines.join("\n").length > best.lines.join("\n").length ? current : best);
    if (!longest.lines.length) break;
    longest.lines.pop();
    longest.cut += 1;
    markdown = scrub(render(), secrets);
  }
  if (markdown.length > REPORT_MAX_CHARS) markdown = markdown.slice(0, REPORT_MAX_CHARS); // unreachable unless the fixed parts alone are too long

  return { markdown, sections, counts: { newSentry: newIssues.length, patterns: recurring.length, blocked, stalls, reviewRounds: rounds2(roundsNow) } };
}

/** The 08:00 job. Never throws: a failure is logged and the next day runs again. Idempotent per date: one file path, one alert row (daily:<date>). */
export async function runDailyReport(ctx: Ctx, now = Date.now()): Promise<string | null> {
  const { bb, db } = ctx;
  try {
    // bounded ledger: nothing older than 90 days is kept, with or without a Chief to report to
    db.prepare(`DELETE FROM chief_events WHERE at < ?`).run(now - LEDGER_RETENTION_MS);
    const project = (await ctx.settings.get()).chiefProject;
    const chief = project ? ctx.chiefForProject(project) : null;
    if (!chief) {
      bb.log.info("Daily report skipped: no active Chief for the configured project.");
      return null;
    }
    const date = localDate(now);
    const { markdown, counts } = await buildDailyReport(ctx, now - DAY_MS, now);
    const path = await ctx.writeStorageFile(chief.thread_id, `reports/daily-${date}.md`, markdown);
    await ctx.alertSelf(chief.thread_id, `daily:${date}`,
      `Daily Chief report: ${path}\n${counts.newSentry} new Sentry issues, ${counts.patterns} recurring patterns, ${counts.blocked} blocked, ${counts.stalls} stalls, ${counts.reviewRounds} review rounds≥2.\nTriage it: read the report, then plan any fix as normal work (chief_plan).`);
    return path;
  } catch (error) {
    bb.log.warn(`Daily report failed: ${String(error)}`);
    return null;
  }
}
