import { clip } from "../core/text";
import type { Ctx } from "../runtime/context";
import { aggregate, applicableRubrics, curve, FAIL_BELOW, INSUFFICIENT, NOT_APPLICABLE, RUBRIC_VERSION } from "./rubrics";
import { normalize, scrub } from "./scrub";
import { ACTIVITY_KINDS, ADAPTERS, type Adapter, collectSources, configuredSecrets, type Item, type Section } from "./sources";

export const REPORT_MAX_CHARS = 60_000;
export const LEDGER_RETENTION_MS = 90 * 86_400_000;
const DAY_MS = 86_400_000;
const TRIAGE = "Triage: read the report, then plan any fix as normal work (chief_plan).";

interface Block { title: string; lines: string[]; cut: number }
export interface DailyCounts { newSentry: number; patterns: number; blocked: number; stalls: number; reviewRounds: number; proposedLessons: number }

/** thread -> whether any scored dimension failed. */
const failedByThread = (rows: { thread_id: string; score: number | null }[]) => {
  const failed = new Map<string, boolean>();
  for (const row of rows) if (row.score !== null) failed.set(row.thread_id, (failed.get(row.thread_id) ?? false) || row.score < FAIL_BELOW);
  return failed;
};
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

  // ---- retro sections: scores are never averaged across rubric_version ----
  interface ScoreRow { thread_id: string; plan_thread_id: string; role: string; scorer: string; rubric_version: string; label: string; score: number | null; reason: string; at: number; detail: string | null }
  const scores = db.prepare(`SELECT * FROM chief_scores WHERE at >= ? AND at < ?`).all(until - 28 * DAY_MS, until) as ScoreRow[];
  const week = (at: number) => { // ISO week of the UTC date
    const d = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    return `${d.getUTCFullYear()}-W${pad(Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7))}`;
  };
  const groups = new Map<string, ScoreRow[]>();
  for (const row of scores) if (row.label !== NOT_APPLICABLE) {
    const key = `${row.rubric_version}\u0000${week(row.at)}\u0000${row.scorer}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  block("Score trend (last 4 ISO weeks, per rubric version)", scores.length ? ["| rubric version | week | scorer | raw mean | curve(mean) | n | pass | fail | insufficient |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => {
      const [version, wk, scorer] = key.split("\u0000");
      const scored = rows.filter((row) => row.score !== null);
      const mean = scored.length ? scored.reduce((total, row) => total + row.score!, 0) / scored.length : null;
      return `| ${version} | ${wk} | ${scorer} | ${mean === null ? "-" : mean.toFixed(3)} | ${mean === null ? "-" : curve(mean).toFixed(3)} | ${scored.length} | ${scored.filter((row) => row.score! >= FAIL_BELOW).length} | ${scored.filter((row) => row.score! < FAIL_BELOW).length} | ${rows.filter((row) => row.label === INSUFFICIENT).length} |`;
    })] : []);

  const comm = scores.filter((row) => row.scorer === "communication" && row.at >= until - 7 * DAY_MS);
  const details = comm.map((row) => { try { return JSON.parse(row.detail ?? "null") as { observed?: Record<string, number | null>; signals?: Record<string, boolean | null> } | null; } catch { return null; } });
  const sumObserved = (name: string) => details.reduce((sum, detail) => sum + (detail?.observed?.[name] ?? 0), 0);
  const mean = (name: string) => { const values = details.map((detail) => detail?.observed?.[name]).filter((value): value is number => typeof value === "number"); return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : "-"; };
  const signalCount = (name: string) => details.filter((detail) => detail?.signals?.[name] === true).length;
  block("Communication (7 days)", comm.length ? [`${comm.length} handoffs judged: ${comm.filter((row) => row.label === INSUFFICIENT).length} insufficient evidence.`,
    `Observed by the plugin: nudges ${sumObserved("nudges")}, blocks ${sumObserved("blocks")}, review rounds ${sumObserved("reviewRounds")}, mean brief ${mean("briefChars")} chars, mean ~${mean("estTokens")} tokens (estimate).`,
    `Attributed by the judge (not observed): ${["briefGapBlock", "askedTwice", "unclearBriefRounds", "userWordsLost"].map((name) => `${name} ${signalCount(name)}`).join(", ")}.`] : []);

  // Calibration: worker threads judged at the current version vs the first bound reviewer verdict. Communication is never calibrated.
  const calibrationRows = new Map<string, { scorer: string; score: number | null; label: string }[]>();
  for (const entry of scores) if (entry.role === "worker" && entry.rubric_version === RUBRIC_VERSION && entry.scorer !== "communication") calibrationRows.set(entry.thread_id, [...(calibrationRows.get(entry.thread_id) ?? []), entry]);
  // Each worker's status is aggregate's over its applicable rubrics: a missing or insufficient dimension is insufficient, never pass.
  const judged = new Map([...calibrationRows].map(([threadId, rows]) => [threadId, aggregate(rows, applicableRubrics(store.get(threadId)?.kind).filter((name) => name !== "communication")).status]));
  const insufficientWorkers = [...judged.values()].filter((status) => status === "insufficient").length;
  const matrixSize = judged.size - insufficientWorkers;
  const matrix = { pass: { approve: 0, request_changes: 0 }, fail: { approve: 0, request_changes: 0 } };
  let bound = 0, unbound = 0;
  for (const [threadId, status] of judged) {
    if (status === "insufficient") continue;
    const verdicts = db.prepare(`SELECT verdict, head_sha, worker_report_seq FROM reviewer_verdicts WHERE worker_thread_id=? ORDER BY id`).all(threadId) as { verdict: "approve" | "request_changes"; head_sha: string | null; worker_report_seq: number | null }[];
    const first = verdicts.find((verdict) => verdict.head_sha !== null && verdict.worker_report_seq !== null);
    if (!first) { if (verdicts.length) unbound += 1; continue; }
    bound += 1;
    matrix[status][first.verdict] += 1;
  }
  const disagree = matrix.pass.request_changes + matrix.fail.approve;
  block("Calibration (judge vs first reviewer verdict, workers, non-communication)", judged.size ? [
    `${matrixSize} workers judged at ${RUBRIC_VERSION}; ${bound} with a bound verdict (coverage ${matrixSize ? Math.round(100 * bound / matrixSize) : 0}%); ${unbound} unbound (null head_sha or worker_report_seq) excluded; ${insufficientWorkers} insufficient, outside the matrix.`,
    ...(bound < 10 ? [`insufficient evidence (n=${bound})`] : [
      "| judge \\ first verdict | approve | request_changes |", "| --- | --- | --- |",
      `| pass | ${matrix.pass.approve} | ${matrix.pass.request_changes} |`, `| fail | ${matrix.fail.approve} | ${matrix.fail.request_changes} |`,
      `Disagreement rate ${Math.round(100 * disagree / bound)}% (${disagree}/${bound}).`]),
  ] : []);

  const failed24 = scores.filter((row) => row.at >= until - DAY_MS && row.score !== null && row.score < FAIL_BELOW && row.scorer !== "communication");
  block("Failed threads (24 h)", failed24.map((row) => `- ${row.thread_id} ${row.role}: ${row.scorer} ${row.label} (${row.score}) — ${clip(row.reason.replace(/\s+/g, " "), 300)}`));

  interface LessonRow { id: number; status: string; surface: string | null; text: string; plan_thread_id: string | null; at: number; decided_at: number | null }
  const lessons = db.prepare(`SELECT id, status, surface, text, plan_thread_id, at, decided_at FROM chief_lessons WHERE surface IS NOT NULL OR status != 'accepted'`).all() as LessonRow[];
  const proposed = lessons.filter((lesson) => lesson.status === "proposed");
  const recurringSurface = new Set([...new Set(proposed.map((lesson) => lesson.surface ?? "other"))].filter((surface) => new Set(proposed.filter((lesson) => (lesson.surface ?? "other") === surface && lesson.at >= until - 14 * DAY_MS && lesson.plan_thread_id).map((lesson) => lesson.plan_thread_id)).size >= 2));
  const decided = db.prepare(`SELECT id, decided_at FROM chief_lessons WHERE status='accepted' AND decided_at >= ?`).all(until - 30 * DAY_MS) as { id: number; decided_at: number }[];
  const passRate = (from: number, to: number) => {
    const status = failedByThread(db.prepare(`SELECT thread_id, score FROM chief_scores WHERE at >= ? AND at < ? AND scorer != 'communication' AND score IS NOT NULL AND rubric_version=?`).all(from, to, RUBRIC_VERSION) as { thread_id: string; score: number }[]);
    const n = status.size;
    return { n, rate: n ? [...status.values()].filter((failedThread) => !failedThread).length / n : 0 };
  };
  block("Lessons", [
    `${proposed.length} proposed awaiting a decision (bb chief lessons --status proposed; accept or retire with a reason); ${lessons.filter((lesson) => lesson.status === "accepted").length} accepted, ${lessons.filter((lesson) => lesson.status === "retired").length} retired (retro and gated lessons).`,
    ...[...new Set(proposed.map((lesson) => lesson.surface ?? "other"))].sort((a, b) => Number(recurringSurface.has(b)) - Number(recurringSurface.has(a)) || a.localeCompare(b)).flatMap((surface) => [
      `### ${surface}${recurringSurface.has(surface) ? " (recurring: 2+ plans in 14 days)" : ""}`,
      ...proposed.filter((lesson) => (lesson.surface ?? "other") === surface).map((lesson) => `- #${lesson.id}: ${clip(lesson.text.replace(/\s+/g, " "), 200)}`)]),
    ...decided.map((lesson) => {
      const beforeRate = passRate(lesson.decided_at - 14 * DAY_MS, lesson.decided_at), afterRate = passRate(lesson.decided_at, Math.min(until, lesson.decided_at + 14 * DAY_MS));
      return `- accepted #${lesson.id}: pass rate before→after ${beforeRate.n < 5 || afterRate.n < 5 ? `too few (n<5; before n=${beforeRate.n}, after n=${afterRate.n})` : `${Math.round(100 * beforeRate.rate)}% (n=${beforeRate.n}) → ${Math.round(100 * afterRate.rate)}% (n=${afterRate.n})`}`;
    }),
  ]);
  const proposedCount = proposed.length;

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

  return { markdown, sections, counts: { newSentry: newIssues.length, patterns: recurring.length, blocked, stalls, reviewRounds: rounds2(roundsNow), proposedLessons: proposedCount } };
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
      `Daily Chief report: ${path}\n${counts.newSentry} new Sentry issues, ${counts.patterns} recurring patterns, ${counts.blocked} blocked, ${counts.stalls} stalls, ${counts.reviewRounds} review rounds≥2, ${counts.proposedLessons} proposed lessons awaiting decision.\nTriage it: read the report, then plan any fix as normal work (chief_plan).`);
    return path;
  } catch (error) {
    bb.log.warn(`Daily report failed: ${String(error)}`);
    return null;
  }
}
