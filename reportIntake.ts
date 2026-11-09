import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ReviewTarget, createReviewLedger } from "./reviewLedger";
import type { Role } from "./roles";
import type { FailEntry, ManagedRow, ReportFinding, ReportParams } from "./server";
import type { ThreadInsert, ThreadStore } from "./threadStore";
import { COMMAND_EXCERPT, MAX_ALERT_LENGTH, clip, fitLines, recordedLines, type RecordedCommand } from "./text";
import { waveTitle } from "./waveSchedule";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** What the report intake needs from the server; the server owns each adapter's implementation. */
export interface ReportIntakeAdapters {
  /** chief_lessons is written only by the intake; the thread store keeps only managed_threads (threadStore.ts:66-67). */
  db: Database;
  store: ThreadStore<ManagedRow>;
  ledger: Pick<ReturnType<typeof createReviewLedger<ManagedRow>>, "recordVerdict" | "targets">;
  lookupRow(threadId: string, callerProjectId: string): Promise<{ row?: ManagedRow; pending?: ThreadInsert<ManagedRow["role"], ManagedRow["state"]> }>;
  writePlan(threadId: string, projectId: string, plan: string | { body: string }[], mirrorFor?: string): Promise<{ path: string }[]>;
  writeArtifact(threadId: string, projectId: string, name: string, content: string): Promise<string>;
  /** In-batch outbox write (server.ts writeAlert). */
  writeAlert(row: ManagedRow, key: string, message: string): void;
  /** Enqueue and deliver (server.ts alertChief). */
  alertChief(row: ManagedRow, key: string, message: string): Promise<boolean>;
  /** In-batch forge comment content builders; they stay in server.ts (docs/specs/forge-comments.md names server.ts as their owner). */
  enqueueVerdictComments(row: ManagedRow, seq: number, verdict: string, findings: ReportFinding[] | undefined, result: string | undefined, recommendation: string | undefined): void;
  enqueueBlockedComment(row: ManagedRow, seq: number, blocker: string | undefined, recommendation: string | undefined): void;
  /** In-batch plan log append (server.ts appendPlanLog). */
  appendPlanLog(row: ManagedRow, entries: (FailEntry & { kind: "FAIL" })[]): void;
  /** The alert's Next line for the row as committed: nextAction(row, true) ?? waveWaitLine(row) ?? the researcher line ?? the inspect line, word for word as today. */
  actionLine(row: ManagedRow): string;
  recordedCommands(threadId: string): Promise<RecordedCommand[] | null>;
  reportStamp(threadId: string): Promise<string | null>;
  /** Hands the files an accepted report wrote to the tracker sync. Called after the commit and before the alert; never awaited, never throws. */
  trackFiles(row: ManagedRow, files: { name: string; content: string }[]): void;
  warn(message: string): void;
}

/** A report whose result fits is short: no file, and no summary needed. */
export const SUMMARY_MAX = 800;
export const MAX_PLAN_LENGTH = 64_000;
// ponytail: arbitrary cap so a runaway plan can't schedule an unbounded worker chain.
export const MAX_WAVES = 8;
export const MAX_REPORT_FAILS = 5;
export const MAX_FINDINGS = 40;
export const REPORT_TEXT_MAX = 4_000;
export const LESSON_MAX = 400;
export const MAX_CARRIED_FAILS = 12;

type WaveInput = { body: string; dependsOn?: number[]; design?: boolean; test?: boolean; spec?: boolean };

/** One Markdown bullet per finding of the given severity, never clipped. */
export function findingLines(list: ReportFinding[], severity: ReportFinding["severity"]) {
  return list.filter((entry) => entry.severity === severity)
    .map((entry) => `- ${entry.file}${entry.line ? `:${entry.line}` : ""} — ${entry.message}${entry.fix ? ` (fix: ${entry.fix})` : ""}`);
}

/** A wave body's `Contracts to verify` section, up to the next heading of the same or higher level. */
export function contractsOf(body: string): string | undefined {
  // ponytail: headings inside code blocks are deliberately out of scope, as for the NOT-doing check.
  const heading = /^[ \t]*(#{1,6})[ \t]+contracts to verify\b.*$/im.exec(body);
  if (!heading) return undefined;
  const rest = body.slice(heading.index + heading[0].length);
  const end = new RegExp(`^[ \\t]*#{1,${heading[1]!.length}}[ \\t]`, "m").exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim() || undefined;
}

/** Whether a spec wave body has a `## Spec baseline` heading (any level). Read at intake only. */
export function hasSpecBaseline(body: string): boolean {
  return /^[ \t]*#{1,6}[ \t]+spec baseline\b/im.test(body);
}

/** Every reason a report cannot be saved, one line per failing field: the field, its actual size or value, the limit, and the fix. */
export function checkReport(row: Pick<ManagedRow, "role" | "plan_thread_id">, params: ReportParams, plan: string | unknown[] | undefined): string[] {
  const errors: string[] = [];
  const num = (n: number) => n.toLocaleString("en-US");
  const ready = params.state === "ready";
  const tooLong = (field: string, value: string | undefined, max: number, fix: string) => {
    if (value !== undefined && value.length > max) errors.push(`${field} is ${num(value.length)} characters; max ${num(max)}. ${fix}`);
  };
  const onlyWhenReady = (field: string, value: unknown) => {
    if (value !== undefined && !ready) errors.push(`${field} is only allowed when state is ready (state is "${params.state}"); remove it.`);
  };

  if (params.summary !== undefined) {
    if (!params.summary) errors.push("summary is empty; send text or omit it.");
    else tooLong("summary", params.summary, SUMMARY_MAX, "Shorten summary, or leave it unset and keep detail in result.");
  }
  if (params.state === "blocked") {
    for (const field of ["blocker", "recommendation"] as const) {
      if (!params[field]) errors.push(`${field} is missing; state blocked needs a blocker and a recommendation.`);
    }
  } else if (params.blocker !== undefined) {
    errors.push(`blocker is only for state blocked (state is "${params.state}"); remove blocker or set state to blocked.`);
  }
  tooLong("blocker", params.blocker, REPORT_TEXT_MAX, "Shorten it and move detail into result.");
  tooLong("recommendation", params.recommendation, REPORT_TEXT_MAX, "Shorten it and move detail into result.");
  if (ready && !params.result) errors.push("result is empty; a ready report needs a non-empty result.");
  onlyWhenReady("verdict", params.verdict);
  onlyWhenReady("lesson", params.lesson);
  onlyWhenReady("regression", params.regression);
  onlyWhenReady("plan", params.plan);
  onlyWhenReady("findings", params.findings);
  // Emptiness, length and role are independent of each other and of state: each failing one gets its own line.
  if (params.lesson !== undefined) {
    if (!params.lesson) errors.push("lesson is empty; send text or omit it.");
    else tooLong("lesson", params.lesson, LESSON_MAX, "Shorten it to one durable rule.");
    if (row.role !== "advisor" && row.role !== "reviewer") errors.push(`lesson is only for an advisor or reviewer's ready report (role is ${row.role}); remove it.`);
  }
  if (row.role === "reviewer" && ready && !params.verdict) {
    errors.push('verdict is missing; a reviewer\'s ready report must carry "approve" when the change can ship as it stands, or "request_changes" when the worker must fix something.');
  }
  if (row.role === "advisor" && row.plan_thread_id && ready && !params.verdict) {
    errors.push("verdict is missing; a plan review's ready report requires verdict: approve or request_changes.");
  }
  if (params.complex !== undefined && (row.role !== "planner" || !ready)) {
    errors.push(`complex is only for a planner's ready report (role is ${row.role}, state is "${params.state}"); remove it.`);
  }
  if (row.role === "worker" && row.plan_thread_id && ready
    && !/^[ \t]*#{1,6}[ \t]+deviations from plan/im.test(params.result ?? "")) {
    errors.push('result lacks a "## Deviations from plan" Markdown heading; a plan worker\'s ready report must list each departure from the plan and why, or "None".');
  }

  // The report intake decodes a JSON string first, so a string left here is not an array.
  if (params.fails !== undefined && !Array.isArray(params.fails)) {
    errors.push("fails: send an array of {text, scope, basis}.");
  } else if (params.fails?.length) {
    if (row.role !== "worker" && row.role !== "reviewer") errors.push(`fails is only for a worker's or reviewer's report (role is ${row.role}); remove it.`);
    if (params.fails.length > MAX_REPORT_FAILS) errors.push(`fails has ${params.fails.length} entries; max ${MAX_REPORT_FAILS}. Keep the ${MAX_REPORT_FAILS} most useful dead ends.`);
    params.fails.forEach((entry, index) => {
      for (const [field, max] of [["text", 400], ["scope", 120], ["basis", 200]] as const) {
        const name = `fails[${index}].${field}`;
        if (typeof entry?.[field] !== "string" || !entry[field]) errors.push(`${name} is empty; send text or drop the entry.`);
        else tooLong(name, entry[field], max, "Shorten it.");
      }
    });
  }

  // The report intake decodes a JSON string first, so a string left here is not an array.
  if (params.findings !== undefined) {
    if (row.role !== "reviewer") errors.push(`findings is only for a reviewer's ready report (role is ${row.role}); remove it.`);
    if (!Array.isArray(params.findings)) errors.push("findings: send an array of {file, line?, severity, message, fix?}.");
    else {
      const list = params.findings as unknown[];
      if (list.length > MAX_FINDINGS) errors.push(`findings has ${list.length} entries; max ${MAX_FINDINGS}. Keep the blocking ones and the most useful nits.`);
      list.forEach((item, index) => {
        const entry = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
        const text = (field: string, min: number, max: number) => {
          const value = entry[field];
          const name = `findings[${index}].${field}`;
          if (value === undefined && min === 0) return;
          if (typeof value !== "string" || value.trim().length < min) errors.push(`${name} is missing or empty; send text.`);
          else tooLong(name, value.trim(), max, "Shorten it.");
        };
        text("file", 1, 300);
        text("message", 1, 1000);
        text("fix", 0, 1000);
        if (entry.line !== undefined && !(Number.isInteger(entry.line) && (entry.line as number) >= 1)) errors.push(`findings[${index}].line is ${JSON.stringify(entry.line)}; send a 1-based integer or omit it.`);
        if (entry.severity !== "blocking" && entry.severity !== "nit") errors.push(`findings[${index}].severity is ${JSON.stringify(entry.severity)}; allowed "blocking" or "nit".`);
      });
      const blocking = list.filter((item) => (item as { severity?: unknown } | null)?.severity === "blocking").length;
      if (params.verdict === "request_changes" && !blocking) errors.push('verdict is request_changes but findings has no "blocking" entry; add the blocking finding or send approve.');
      if (params.verdict === "approve" && blocking) errors.push(`verdict is approve but findings has ${blocking} "blocking" ${blocking > 1 ? "entries" : "entry"}; send request_changes or mark them "nit".`);
    }
  } else if (row.role === "reviewer" && ready) {
    errors.push("findings is missing; send [] when there are none.");
  }

  // The plan's own shape and rules are checked whatever the state and role; those two have their own lines.
  if (plan !== undefined) {
    if (row.role !== "planner") errors.push(`plan is only for a planner's ready report (role is ${row.role}); remove it.`);
    errors.push(...checkPlan(plan));
  } else if (row.role === "planner" && ready) {
    errors.push("plan is missing; a planner's ready report requires the full plan body, as an array of {body, dependsOn?, design?, test?}.");
  }
  return errors;
}

/** The plan-shape and planner-rule lines for checkReport. Each wave is inspected
 * on its own, so one bad wave never hides another's failures; a check is skipped only when its own input is invalid. */
export function checkPlan(plan: string | unknown[]): string[] {
  const errors: string[] = [];
  const num = (n: number) => n.toLocaleString("en-US");
  const kind = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`;
  if (Array.isArray(plan) && !plan.length) return [`plan is an empty array; pass an array of {body, dependsOn?, design?, test?} with 2 to ${MAX_WAVES} waves.`];
  const multi = typeof plan !== "string";
  if (!multi) errors.push(`plan needs at least two waves: implementation wave(s), then a test wave (test: true) ending each chain; pass an array of {body, dependsOn?, design?, test?}.`);
  const items: unknown[] = multi ? plan : [{ body: plan }];
  if (items.length > MAX_WAVES) errors.push(`plan has ${items.length} waves; max ${MAX_WAVES}. Merge waves.`);
  // Per wave: its trimmed body (undefined when missing or not a string), the legal earlier waves it may build on
  // ("any" when dependsOn is not an array), its parent when dependsOn passed every check (null = chain head), and whether design is true.
  const bodies: (string | undefined)[] = [];
  const maybeParents: (number[] | "any")[] = [];
  const parents: (number | null | undefined)[] = [];
  const designs: boolean[] = [];
  const tests: boolean[] = [];
  items.forEach((item, index) => {
    const n = index + 1;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`plan wave ${n} is ${kind(item)}, not an object; use {body, dependsOn?, design?, test?}.`);
      bodies.push(undefined); maybeParents.push("any"); parents.push(undefined); designs.push(false); tests.push(false);
      return;
    }
    const wave = item as { body?: unknown; dependsOn?: unknown; design?: unknown; test?: unknown; spec?: unknown };
    const name = multi ? `plan wave ${n} body` : "plan";
    const body = typeof wave.body === "string" ? wave.body.trim() : undefined;
    bodies.push(body);
    if (body === undefined) errors.push(`${name} is ${wave.body === undefined ? "missing" : kind(wave.body)}; send the wave's Markdown text as a string, with its own "## Contracts to verify" heading.`);
    else if (!body) errors.push(`${name} is empty; send the plan text.`);
    else if (body.length > MAX_PLAN_LENGTH) errors.push(`${name} is ${num(body.length)} characters; max ${num(MAX_PLAN_LENGTH)}. ${multi ? "Split the wave." : "Split it into waves."}`);
    if (wave.design !== undefined && typeof wave.design !== "boolean") {
      errors.push(`plan wave ${n} design is ${JSON.stringify(wave.design)} (${typeof wave.design}); allowed true or false. Send a boolean, or drop design.`);
    }
    designs.push(wave.design === true);
    if (wave.test !== undefined && typeof wave.test !== "boolean") {
      errors.push(`plan wave ${n} test is ${JSON.stringify(wave.test)} (${typeof wave.test}); allowed true or false. Send a boolean, or drop test.`);
    }
    tests.push(wave.test === true);
    if (wave.design === true && wave.test === true) errors.push(`plan wave ${n} is both design: true and test: true; a wave is one or the other.`);
    if (wave.spec !== undefined && typeof wave.spec !== "boolean") {
      errors.push(`plan wave ${n} spec is ${JSON.stringify(wave.spec)} (${typeof wave.spec}); allowed true or false. Send a boolean, or drop spec.`);
    } else if (wave.spec === true && (wave.test === true || wave.design === true)) {
      errors.push(`plan wave ${n} is spec: true and ${wave.test === true ? "test" : "design"}: true; spec marks an implementation wave only.`);
    } else if (wave.spec === true && body && !/^[ \t]*#{1,6}[ \t]+spec delta/im.test(body)) {
      errors.push(`plan wave ${n} is spec: true but lacks a "## Spec delta" Markdown heading naming the docs the Spec Writer changes; add one, or drop spec.`);
    }
    if (body && hasSpecBaseline(body) && wave.spec !== true) {
      errors.push(`plan wave ${n} has a "## Spec baseline" heading but is not spec: true; a baseline belongs to the spec wave that creates a new docs/specs file. Mark the wave spec: true, or drop the heading.`);
    }
    const deps = wave.dependsOn;
    const bad = (what: string, fix: string) => errors.push(`plan wave ${n} dependsOn is ${JSON.stringify(deps)}, ${what}; ${fix}`);
    if (deps === undefined) { maybeParents.push(n > 1 ? [n - 1] : []); parents.push(n > 1 ? n - 1 : null); return; }
    if (!Array.isArray(deps)) {
      bad(`${kind(deps)}, not an array`, "use [] or [k] with k the 1-based earlier wave.");
      maybeParents.push("any"); parents.push(undefined);
      return;
    }
    // Type, count and range are independent: report each that fails, so one fix pass clears them all.
    const nonIntegers = deps.filter((k) => !Number.isInteger(k));
    const outOfRange = deps.filter((k) => Number.isInteger(k) && (k < 1 || k >= n));
    if (nonIntegers.length) bad(`entries ${JSON.stringify(nonIntegers)} are not integers`, "use 1-based wave numbers.");
    if (deps.length > 1) bad(`${deps.length} entries but max is 1`, "name only the wave it builds on.");
    if (outOfRange.length) bad(`${JSON.stringify(outOfRange)} ${outOfRange.length > 1 ? "are not earlier waves" : "is not an earlier wave"}`, n === 1 ? "wave 1 depends on nothing; use []." : `use [] or one wave from 1 to ${n - 1}.`);
    maybeParents.push(deps.filter((k) => Number.isInteger(k) && k >= 1 && k < n));
    parents.push(nonIntegers.length || outOfRange.length || deps.length > 1 ? undefined : deps[0] ?? null);
  });
  // ponytail: headings inside code blocks are deliberately out of scope (user decision).
  // The heading must be in some wave, so it is demanded whenever no readable body has it, even if another body is unreadable.
  if (!bodies.some((body) => body !== undefined && /^[ \t]*#{1,6}[ \t]+what we(?:'re|’re| are) not doing/im.test(body))) {
    errors.push(`plan lacks a "## What we're NOT doing" Markdown heading (any level, not bold text) in some wave; add one.${typeof plan === "string" && plan.startsWith("[")
      ? " If you meant to send several waves, pass plan as an actual array of {body}, not a JSON string." : ""}`);
  }
  bodies.forEach((body, index) => {
    if (body !== undefined && !contractsOf(body)) errors.push(`plan wave ${index + 1} lacks a "## Contracts to verify" Markdown heading listing the invariants its worker must keep and its reviewer will check (a heading, not bold text); add one.`);
  });
  // A design wave is a chain tip when no later wave could build on it; a later wave whose dependsOn is not an array might, so it blocks the check.
  designs.forEach((design, index) => {
    const n = index + 1;
    if (design && maybeParents.every((candidates, other) => other <= index || (candidates !== "any" && !candidates.includes(n)))) {
      errors.push(`plan wave ${n} is design: true but no wave builds on it; follow it with the wave that implements it (dependsOn [${n}] or the next wave), or drop design.`);
    }
  });
  // Every chain ends with a test wave: a tip no later wave could build on must be test: true. A test wave is a tip
  // with a parent that is an implementation wave (neither design nor test). Skipped where dependsOn is invalid.
  if (multi) items.forEach((_, index) => {
    const n = index + 1;
    const tip = maybeParents.every((candidates, other) => other <= index || (candidates !== "any" && !candidates.includes(n)));
    if (tip && !tests[index] && !designs[index]) errors.push(`plan wave ${n} ends a chain but is not test: true; follow it with a test wave (test: true, dependsOn [${n}]) that tests it.`);
    if (!tests[index]) return;
    if (parents.some((parent, other) => other > index && parent === n)) errors.push(`plan wave ${n} is test: true but a later wave builds on it; a test wave ends its chain.`);
    const parent = parents[index];
    if (parent === null) errors.push(`plan wave ${n} is test: true but starts a chain; set dependsOn [k] with k the chain's last implementation wave.`);
    else if (parent !== undefined && (designs[parent - 1] || tests[parent - 1])) errors.push(`plan wave ${n} is test: true but builds on ${designs[parent - 1] ? "design" : "test"} wave ${parent}; build it on the chain's last implementation wave.`);
  });
  const taken = new Set<number>();
  parents.forEach((parent, index) => {
    if (parent === undefined || parent === null) return;
    if (taken.has(parent)) errors.push(`plan wave ${index + 1} and another wave both build on wave ${parent}; waves form chains only, so mark one of them dependsOn [] or chain it after the other.`);
    taken.add(parent);
  });
  return errors;
}

export type Pointer = { line: string; name: string | null };

/** Everything the alert layout reads. All of it is decided before the first pass, so layout is pure. */
export type ReportAlertInput = {
  role: Role;
  title: string;
  threadId: string;
  params: ReportParams;
  action: string;
  /** null means the event-log read failed, undefined means none was requested. */
  recorded: RecordedCommand[] | null | undefined;
  failList: readonly unknown[] | undefined;
  verdict: string | null;
  verdictPath: string | null;
  waveLines: string[];
  inlinePlans: string[];
  preview: boolean;
  /** `Read at <sha>…` for a researcher or planner report, else null. */
  stamp: string | null;
};

  // The alert is built in two tiers. The required lines come first, each with its own hard budget (header,
  // State, the Full report pointer, Verdict and Verdict file, action, Blocker, Recommendation); their total is
  // reserved out of the alert. Only what is left goes to optional detail: planner wave paths and inline-vis
  // lines, Recorded commands, then Result or Summary. Whatever is cut lives unabridged in the full file:
  // report-<seq>.md, or for a reviewer's verdict its verdict-<seq>.md. Both names carry the report number,
  // so no file an earlier alert pointed at is ever overwritten.
export function reportAlert(input: ReportAlertInput) {
  const { role, title, threadId, params, action, recorded, failList, verdict, verdictPath, waveLines, inlinePlans, preview, stamp } = input;
  const FIELD_ROOM = 600;
  const ACTION_ROOM = 400;
  const MIN_RESULT_ROOM = 200;
  const alertRoom = MAX_ALERT_LENGTH - "[Chief lifecycle alert]\n".length;
  const longLabel = "Result (clipped, full text in the report file): ";
  const inlineIntro = "To show the plan to the user, put each line below alone on its own line in your reply (not in a code block):";
  const cost = (lines: string[]) => lines.reduce((total, line) => total + line.length + 1, 0);
  return (pointer: Pointer | null) => {
    const stored = !!pointer?.name;
    const summaryLine = !!params.summary && (preview || stored || !params.result);
    const resultText = summaryLine ? params.summary! : params.result ?? null;
    // A Result the file backs up is sized for the longer label, so it can say it was clipped.
    const filed = stored && !summaryLine && !preview;
    const sizeLabel = summaryLine ? "Summary: " : filed ? longLabel : "Result: ";
    // A reviewer's fallback preview keeps the legacy 300; a supplied summary is budgeted like any Result.
    const cap = preview && !summaryLine ? 300 : Infinity;
    // ponytail: the pointer and Verdict file lines carry absolute storage paths unclipped; BB keeps the root short
    // (~/.bb/chief/<projectId>/<threadId>/), so the budget assumes roots well under ~1600 characters. Bound them if that changes.
    const top = [
      clip(`${role[0]!.toUpperCase()}${role.slice(1)} report from ${title} (${threadId})`, 200),
      `State: ${params.state}`,
      ...(stamp ? [clip(stamp, 160)] : []),
      ...(pointer ? [pointer.line] : []),
      ...(failList?.length ? [`Fails: ${failList.length} ruled out (carried to any replaces: successor)`] : []),
    ];
    const planHead = waveLines.length ? [`Plan: ${waveLines.length} wave(s)`] : [];
    const verdictLines = [...(verdict ? [`Verdict: ${verdict}`] : []), ...(verdictPath ? [`Verdict file: ${verdictPath}`] : [])];
    const actionLine = clip(action, ACTION_ROOM);
    const inspectLine = preview ? [`Full report and last output: bb chief inspect ${threadId}`] : [];
    const recordedHead = recorded === undefined ? [] : recordedLines(recorded, 0);
    const blocker = params.state === "blocked" ? params.blocker! : null;
    const fieldCount = (blocker === null ? 0 : 1) + (params.recommendation ? 1 : 0);
    const lessonLines = params.state === "ready" && params.lesson ? [`Lesson recorded for future managed threads: ${clip(params.lesson, 300)}`] : [];
    const fixedCost = cost([...top, ...planHead, ...verdictLines, actionLine, ...lessonLines, ...inspectLine, ...recordedHead]);
    const fieldRoom = Math.min(FIELD_ROOM, Math.max(100, Math.floor((alertRoom - fixedCost) / Math.max(fieldCount, 1)) - 20));
    const suffix = pointer?.name ? ` (clipped; full text in ${pointer.name})` : " (clipped)";
    const field = (name: string, value: string) => `${name}: ${value.length <= fieldRoom ? value : `${clip(value, fieldRoom - suffix.length)}${suffix}`}`;
    const fields = [...(blocker === null ? [] : [field("Blocker", blocker)]), ...(params.recommendation ? [field("Recommendation", params.recommendation)] : [])];
    const remaining = alertRoom - fixedCost - cost(fields);
    // Optional detail gets what the required lines leave, minus a floor for Result.
    let room = remaining - (resultText ? sizeLabel.length + Math.min(resultText.length, cap, MIN_RESULT_ROOM) + 1 : 0);
    const waveFit = fitLines(waveLines, room);
    room -= cost(waveFit.lines);
    const inlineFit = fitLines(inlinePlans, room - inlineIntro.length - 1, false);
    const inlineBlock = inlineFit.lines.length ? [inlineIntro, ...inlineFit.lines] : [];
    room -= cost(inlineBlock);
    const commands = recorded === undefined ? [] : recordedLines(recorded, room).slice(1);
    const resultRoom = Math.min(cap, remaining - cost(waveFit.lines) - cost(inlineBlock) - cost(commands) - sizeLabel.length - 1);
    const resultCut = !!resultText && resultText.length > resultRoom;
    // A file-bearing report (first pass long or clipped) labels its Result as clipped; only a short, unclipped one stays plain.
    const label = filed ? longLabel : summaryLine ? "Summary: " : "Result: ";
    const text = [
      ...top, ...planHead, ...waveFit.lines, ...inlineBlock, ...verdictLines, actionLine, ...fields, ...lessonLines, ...inspectLine,
      ...recordedHead, ...commands,
      ...(resultText && resultRoom > 0 ? [`${label}${clip(resultText, resultRoom)}`] : []),
    ].join("\n");
    const clipped = text.length > alertRoom
      || action.length > ACTION_ROOM
      || (blocker !== null && blocker.length > fieldRoom)
      || (params.recommendation?.length ?? 0) > fieldRoom
      || waveFit.cut || inlineFit.cut
      || (!!recorded && (commands.filter((line) => !line.startsWith("  …and ")).length < recorded.length
        || recorded.some((entry) => entry.command.length > COMMAND_EXCERPT)))
      || resultCut;
    return { text, clipped };
  };
}

/** The body of verdict-<seq>.md. */
export function verdictFileBody(input: {
  threadId: string;
  verdict: string | null;
  regressionFlag: boolean;
  reviewedTargets: ReviewTarget[];
  workerThreadId: string | null | undefined;
  reviewedHeadSha: string | null | undefined;
  findingList: ReportFinding[] | undefined;
  result: string | undefined;
  recommendation: string | undefined;
}) {
  const { threadId, verdict, regressionFlag, reviewedTargets, workerThreadId, reviewedHeadSha, findingList, result, recommendation } = input;
  return [
    `# Review verdict (${threadId})`, "",
    `Verdict: ${verdict}`, ...(regressionFlag ? ["Regression: yes"] : []),
    ...(reviewedTargets.length > 1
      ? reviewedTargets.map((target) => `Reviewed worker: ${target.worker_thread_id}${target.head_sha ? ` at head ${target.head_sha}` : ""}`)
      : [`Reviewed worker: ${workerThreadId ?? "none"}`, ...(reviewedHeadSha ? [`Reviewed head: ${reviewedHeadSha}`] : [])]),
    ...(findingList?.some((entry) => entry.severity === "blocking") ? ["", "## Blocking findings", "", ...findingLines(findingList, "blocking")] : []),
    ...(findingList?.some((entry) => entry.severity === "nit") ? ["", "## Nits", "", ...findingLines(findingList, "nit")] : []),
    "", "## Findings", "", result ?? "",
    ...(recommendation ? ["", "## Recommendation", "", recommendation] : []),
  ].join("\n") + "\n";
}

/** The body of report-<seq>.md. */
export function reportFileBody(input: {
  role: Role;
  title: string;
  threadId: string;
  params: ReportParams;
  verdict: string | null;
  action: string;
  waveLines: string[];
  inlinePlans: string[];
  recorded: RecordedCommand[] | null | undefined;
  stamp?: string | null;
}) {
  const { role, title, threadId, params, verdict, action, waveLines, inlinePlans, recorded, stamp } = input;
  return [
    `# ${role[0]!.toUpperCase()}${role.slice(1)} report from ${title} (${threadId})`, "",
    `State: ${params.state}`, ...(stamp ? [clip(stamp, 160)] : []), ...(verdict ? [`Verdict: ${verdict}`] : []), `Next: ${action}`,
    ...(waveLines.length ? ["", "## Plan files", "", ...waveLines, ...inlinePlans] : []),
    ...(params.state === "blocked" ? ["", "## Blocker", "", params.blocker!] : []),
    ...(params.recommendation ? ["", "## Recommendation", "", params.recommendation] : []),
    ...(recorded === undefined ? [] : ["", "## Recorded", "", ...recordedLines(recorded, Infinity, true)]),
    ...(params.summary ? ["", "## Summary", "", params.summary] : []),
    ...(params.result ? ["", "## Result", "", params.result] : []),
  ].join("\n") + "\n";
}

/** The one owner of chief_report acceptance and publication: required state commits first, then the optional files and the alert. */
export function createReportIntake(adapters: ReportIntakeAdapters): { report(threadId: string, params: ReportParams, callerProjectId: string): Promise<boolean> } {
  const { db, store, ledger, lookupRow, writePlan, writeArtifact, writeAlert, alertChief, enqueueVerdictComments, enqueueBlockedComment, appendPlanLog, actionLine, recordedCommands, reportStamp, trackFiles, warn } = adapters;
  async function report(threadId: string, params: ReportParams, callerProjectId: string) {
    const found = await lookupRow(threadId, callerProjectId);
    // A row recovered from spawn metadata is only a candidate until the report validates: a rejection writes nothing.
    const candidate = found.row ?? (found.pending && { role: found.pending.role, plan_thread_id: null });
    if (!candidate || candidate.role === "chief") throw new Error("chief_report is available only in managed worker, planner, reviewer, and advisor threads.");
    if (found.row && ["complete", "archived", "deleted"].includes(found.row.state)) {
      throw new Error(`Managed thread ${threadId} is ${found.row.state} and can no longer report.`);
    }
    // Some planners send the wave array JSON-encoded; the string branch would take it as one flat wave.
    let plan: string | unknown[] | undefined = params.plan;
    if (typeof plan === "string" && plan.startsWith("[")) {
      let decoded: unknown;
      try { decoded = JSON.parse(plan); } catch { decoded = undefined; }
      if (Array.isArray(decoded)) plan = decoded;
    }
    let reportFails = params.fails;
    if (typeof reportFails === "string") {
      try { reportFails = JSON.parse(reportFails); } catch { /* checkReport refuses the string */ }
    }
    let reportFindings = params.findings;
    if (typeof reportFindings === "string") {
      try { reportFindings = JSON.parse(reportFindings); } catch { /* checkReport refuses the string */ }
    }
    const errors = checkReport(candidate, { ...params, fails: reportFails, findings: reportFindings }, plan);
    if (errors.length) throw new Error(`chief_report was not saved; fix all of these and call it once more:\n${errors.map((line) => `- ${line}`).join("\n")}`);
    // The launch row may have landed while the lookup awaited; keep it, as a recovery candidate has no PR or branch.
    if (found.pending && !store.get(threadId)) store.insert(found.pending);
    const row = store.get(threadId)!;
    // checkReport proved the shape: a wave array here is {body, dependsOn?, design?, test?, spec?}[], with bodies not yet trimmed if JSON-decoded.
    const waveList = Array.isArray(plan) ? (plan as WaveInput[]).map((wave) => ({ ...wave, body: wave.body.trim() })) : undefined;
    const planInput: string | WaveInput[] | undefined = waveList ?? (plan as string | undefined);
    const verdict = params.state === "ready" ? params.verdict ?? null : null;
    const plannerReady = row.role === "planner" && params.state === "ready";
    const planWaves = plannerReady && planInput ? await writePlan(threadId, row.project_id, planInput) : null;
    const scheduledWaves = planWaves && planInput
      ? planWaves.map((wave, index) => ({ ...wave, contracts: contractsOf(typeof planInput === "string" ? planInput : planInput[index]!.body)!,
        title: waveTitle(typeof planInput === "string" ? planInput : planInput[index]!.body),
        ...(typeof planInput !== "string" && planInput[index]!.dependsOn ? { dependsOn: planInput[index]!.dependsOn } : {}),
        ...(typeof planInput !== "string" && planInput[index]!.design ? { design: true } : {}),
        ...(typeof planInput !== "string" && planInput[index]!.test ? { test: true } : {}),
        ...(typeof planInput !== "string" && planInput[index]!.spec ? { spec: true } : {}),
        ...(typeof planInput !== "string" && planInput[index]!.spec && hasSpecBaseline(planInput[index]!.body) ? { baseline: true } : {}) }))
      : null;
    // Best-effort mirror into Chief's storage: inline-vis resolves paths against the rendering thread.
    let inlinePlans: string[] = [];
    if (planWaves && planInput && row.chief_thread_id) {
      try {
        await writePlan(threadId, row.project_id, planInput, row.chief_thread_id);
        inlinePlans = planWaves.map((wave) => `::inline-vis{source="thread-storage" file="plans/${threadId}/${basename(wave.path)}"}`);
      } catch (error) {
        warn(`Could not mirror ${threadId}'s plan into Chief's storage: ${String(error)}`);
      }
    }
    // checkReport proved the shape: reportFails is an array of {text, scope, basis} or unset.
    const failList = reportFails as FailEntry[] | undefined;
    let fails: string | null = null;
    if (failList?.length) {
      const key = (entry: FailEntry) => `${entry.scope}\u0000${entry.text}`;
      const fresh = new Set(failList.map(key));
      const kept = (row.fails ? JSON.parse(row.fails) as FailEntry[] : []).filter((entry) => !fresh.has(key(entry)));
      const at = Date.now();
      const incoming = failList.filter((entry, index) => failList.findIndex((other) => key(other) === key(entry)) === index)
        .map((entry) => ({ ...entry, at }));
      fails = JSON.stringify([...kept, ...incoming].slice(-MAX_CARRIED_FAILS));
    }
    // checkReport proved the shape; only a reviewer's ready report carries findings.
    const findingList = (reportFindings as ReportFinding[] | undefined)?.map((entry) => ({ ...entry, file: entry.file.trim(), message: entry.message.trim(), ...(entry.fix !== undefined ? { fix: entry.fix.trim() } : {}) }));
    const regressionFlag = params.state === "ready" && params.regression === true && verdict === "request_changes";
    const now = Date.now();
    // A reviewer's active_cycle counts every resume, not rejection rounds — a
    // reviewer resumed for an unrelated reason must not read as a deadlock.
    // reject_streak counts only consecutive request_changes verdicts, and
    // resets the moment either side breaks the streak with an approve.
    // report_seq is reserved here, so the per-report file names below never collide.
    const { report_seq: seq, result_rev: resultRev } = store.batch(() => {
      const reserved = store.reserveReport({
        threadId, state: params.state, result: params.result ?? null, summary: params.summary ?? null,
        blocker: params.state === "blocked" ? params.blocker ?? null : null,
        recommendation: params.recommendation ?? null, verdict,
        planWaves: scheduledWaves ? JSON.stringify(scheduledWaves) : null, regression: regressionFlag ? 1 : 0, fails,
        findings: row.role === "reviewer" && findingList ? JSON.stringify(findingList) : null, now,
      });
      if (row.role === "advisor" && (params.state === "ready" || params.state === "blocked")) {
        store.markAdvised(threadId, now);
        // The plan's one review: the first advice from any of its advisors decides it.
        if (row.plan_thread_id) store.resolvePlanReview(row.plan_thread_id, params.state === "ready" && verdict === "approve" ? "approved" : "changes");
      }
      if (plannerReady && scheduledWaves) {
        store.setPlanReview(threadId, (scheduledWaves.filter((wave) => !wave.test).length > 1 || params.complex === true) && !row.replaces_thread_id ? "required" : null);
        const revised = row.replaces_thread_id ? store.get(row.replaces_thread_id) : undefined;
        if (revised?.role === "planner" && revised.plan_review === "changes") store.completeSuperseded(revised.thread_id, now);
      }
      if ((row.role === "advisor" || row.role === "reviewer") && params.state === "ready" && params.lesson) {
        db.prepare(`INSERT INTO chief_lessons (project_id, text, source_thread_id, worker_thread_id, at, role) VALUES (?, ?, ?, ?, ?, ?)`).run(row.project_id, params.lesson, threadId, row.worker_thread_id, now, row.role);
      }
      ledger.recordVerdict(row, verdict, reserved.report_seq, now);
      if (row.role === "reviewer" && params.state === "ready" && verdict) {
        enqueueVerdictComments(row, reserved.report_seq, verdict, findingList, params.result, params.recommendation);
      } else if (row.role === "worker" && params.state === "blocked") {
        enqueueBlockedComment(row, reserved.report_seq, params.blocker, params.recommendation);
      }
      // Same transaction as the state commit: a crash before the full alert below still leaves Chief a pointer.
      // The final alert's key shares the report: kind, so it evicts this row while undelivered.
      if (row.chief_thread_id) {
        const body = clip(params.summary ?? params.result ?? "", 300);
        writeAlert(row, `report:${row.active_cycle}:pending-${reserved.report_seq}`, [
          `${row.title} (${threadId}) reported ${params.state} (report ${reserved.report_seq}).`,
          ...(body ? [body] : []),
          `The full alert could not be built; run chief_inspect ${threadId}.`,
        ].join("\n"));
      }
      // A plan worker's fails also reach its peer waves through chief_log, so it need not post them twice.
      if (row.role === "worker" && row.plan_thread_id && failList?.length) {
        appendPlanLog(row, failList.map((entry) => ({ ...entry, kind: "FAIL" as const })));
      }
      return reserved;
    });
    const current = store.get(threadId)!;
    const action = actionLine(current);
    const recorded = row.role === "worker" && params.state === "ready" ? await recordedCommands(threadId) : undefined;
    const verdictName = `verdict-${seq}.md`;
    const reportName = `report-${seq}.md`;
    const reviewerVerdict = row.role === "reviewer" && !!verdict;
    // Best-effort: the verdict is in the DB either way, so a failed write only loses the file.
    let verdictPath: string | null = null;
    let verdictBody: string | null = null;
    const reviewedTargets = reviewerVerdict ? ledger.targets(threadId) : [];
    if (reviewerVerdict) {
      try {
        verdictBody = verdictFileBody({
          threadId, verdict, regressionFlag, reviewedTargets, workerThreadId: row.worker_thread_id, reviewedHeadSha: row.reviewed_head_sha,
          findingList, result: params.result, recommendation: params.recommendation,
        });
        verdictPath = await writeArtifact(threadId, row.project_id, verdictName, verdictBody);
      } catch (error) {
        warn(`Could not write ${threadId}'s verdict file: ${String(error)}`);
      }
    }
    const longResult = (params.result?.length ?? 0) > SUMMARY_MAX;
    // A reviewer's full findings live in the verdict file: the alert carries a preview and where to read the rest.
    const preview = reviewerVerdict && !!verdictPath && !!params.result;
    const waveLines = plannerReady && planWaves ? planWaves.map((wave, index) => `Wave ${index + 1} of ${planWaves.length}: ${wave.path}`) : [];
    // Optional enrichment: the state, seq and pending alert are already committed above.
    const stamp = row.role === "researcher" || row.role === "planner" ? await reportStamp(threadId) : null;
    const layout = reportAlert({ role: row.role, title: row.title, threadId, params, action, recorded, failList, verdict, verdictPath, waveLines, inlinePlans, preview, stamp });
    // Long-or-clipped is decided from this first pass; the pass that follows only adds the pointer.
    const first = layout(null);
    let alert = first.text;
    let reportPath: string | null = null;
    if (reviewerVerdict) {
      // A reviewer with a verdict never gets a report file: its verdict file is the full report.
      if (!verdictPath) alert = layout({ line: `Full report: could not write ${verdictName} (see the plugin log)`, name: null }).text;
      else if (longResult || first.clipped) alert = layout({ line: `Full report: ${verdictPath}`, name: verdictName }).text;
    } else if (longResult || first.clipped) {
      let pointer: Pointer;
      try {
        reportPath = await writeArtifact(threadId, row.project_id, reportName, reportFileBody({
          role: row.role, title: row.title, threadId, params, verdict, action, waveLines, inlinePlans, recorded, stamp,
        }));
        pointer = { line: `Full report: ${reportPath}`, name: reportName };
      } catch (error) {
        warn(`Could not write ${threadId}'s report file: ${String(error)}`);
        pointer = { line: `Full report: could not write ${reportName} (see the plugin log)`, name: null };
      }
      alert = layout(pointer).text;
    }
    // Guarded by report_seq, and report_path also by result_rev: a slow write never attaches its path to a
    // newer report, nor to a result chief_complete replaced meanwhile (even with identical text). Always runs, so a
    // report without a verdict still clears the previous verdict_path as the main UPDATE used to.
    store.attachReportFiles(threadId, seq, resultRev, verdictPath, reportPath);
    const files = [
      ...(planWaves && planInput ? planWaves.map((wave, index) => ({ name: basename(wave.path), content: `${typeof planInput === "string" ? planInput : planInput[index]!.body}\n` })) : []),
      ...(verdictPath && verdictBody !== null ? [{ name: verdictName, content: verdictBody }] : []),
    ];
    if (files.length) trackFiles(current, files);
    const contentKey = createHash("sha1").update(alert).digest("hex").slice(0, 16);
    return alertChief(store.get(threadId) ?? current, `report:${current.active_cycle}:${contentKey}`, alert);
  }
  return { report };
}
