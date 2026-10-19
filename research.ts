import type { ExecFileOptions } from "node:child_process";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ManagedSpawn } from "./managedSpawn";
import { READ_ONLY, RESEARCH_ONLY, researchRoleSchema, type ResearchRole } from "./roles";

/** How long one chief_research call waits before handing back a runId to resume with. */
export const RESEARCH_DEFAULT_TIMEOUT_MINUTES = 10;
/** Hard ceiling on one chief_research call's wait, whatever the configured timeout.
 * acp-antigravity ends MCP tool calls at 180 s, and BB ends them at about 5 minutes.
 * ponytail: BB's daemon-to-server tool-call fetch dies at undici's 300 s body timeout and then stops the run; the 1-minute margin
 * covers the final status, history and failureNote CLI calls (up to 30 s each) that can run after the deadline.
 * Drop the cap once BB streams keepalive bytes or the daemon disables the body timeout. */
const RESEARCH_CALL_WAIT_CAP_MS = 150_000;
/** How long a researcher has to report after its run ended before the server alerts Chief with the result. */
const RESEARCH_REPORT_GRACE_MS = 3 * 60_000;
/** Consecutive status-read failures before checkUnreported alerts Chief that it cannot read a run. */
const RESEARCH_UNREAD_LIMIT = 5;
const RESEARCH_POLL_MS = 3_000;
const MAX_RESEARCH_OUTPUT = 32_000;
const RESEARCH_PREAMBLE = `READ-ONLY: ${READ_ONLY}, and run no command that changes tracked files or git state; you share the caller's checkout.`;

const reasoningSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);
export const modelSelectionSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: reasoningSchema,
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

const stageSchema = z.enum(["scan", "verify", "combine"]);
export const researchModeSchema = z.enum(["survey", "investigate"]);
type Stage = z.infer<typeof stageSchema>;
export type ResearchMode = z.infer<typeof researchModeSchema>;
/** Which modes each role may run. */
const RESEARCH_MODES: Record<ResearchRole, z.infer<typeof researchModeSchema>[]> = {
  chief: ["survey", "investigate"],
  planner: ["survey", "investigate"],
  researcher: ["survey", "investigate"],
};
export const agentCapSchema = z.number().int().min(1).max(100);
/** How long one chief_research call waits, in minutes; the run itself keeps going. */
export const timeoutSchema = z.number().int().min(1).max(60);
/** One config for every role: Chief and planners share the switch, the cap, and each mode's timeout. */
export const researchSettingsSchema = z.object({
  enabled: z.boolean(),
  maxAgentCalls: agentCapSchema,
  timeoutMinutes: z.object({ survey: timeoutSchema, investigate: timeoutSchema }),
});
export type ResearchSettings = z.infer<typeof researchSettingsSchema>;
export const researchConfigurationSchema = z.object({
  settings: researchSettingsSchema,
  hosts: z.array(z.object({
    hostId: z.string(),
    hostName: z.string(),
    connected: z.boolean(),
    fallback: modelSelectionSchema.nullable(),
    error: z.string().nullable(),
    /** One pick per mode for every stage and role; null inherits the caller's model. */
    selections: z.object({
      survey: modelSelectionSchema.nullable(),
      investigate: modelSelectionSchema.nullable(),
    }),
    /** Modes whose pick this machine can no longer serve, so their stages inherit the caller's model. */
    unusable: z.array(researchModeSchema),
  })),
});
export type ResearchConfiguration = z.infer<typeof researchConfigurationSchema>;
export const researchSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  maxAgentCalls: agentCapSchema.optional(),
  timeoutMinutes: z.object({
    survey: timeoutSchema.optional(),
    investigate: timeoutSchema.optional(),
  }).strict().optional(),
}).strict();
/** A workflow agent selection: all three fields or none, never a partial triple. */
const workflowSelectionSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: reasoningSchema,
}).strict();
type WorkflowSelection = z.infer<typeof workflowSelectionSchema>;
const textList = (what: string) => z.array(z.string().trim().min(1).max(1_000)).min(1).max(20).optional().describe(what);
/** One flat object with a per-mode check, not a union: tool parameters must publish as a JSON Schema of type object. */
export const researchParams = z.object({
  mode: researchModeSchema.optional().describe("survey: one row per item. investigate: one answer per sub-question, merged into a brief. Required unless resuming with runId."),
  question: z.string().trim().min(1).max(4_000).optional().describe("The overall question or goal. Required unless resuming."),
  items: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100).optional().describe("survey: files, symbols, or topics; each gets a row."),
  batchSize: z.number().int().min(1).max(100).default(1).describe("survey: items per scan agent. Scan agents = ceil(items ÷ batchSize); aim for about 10 or fewer, since each runs concurrently and spends quota."),
  questions: textList("investigate: sub-questions, one scan agent each."),
  verify: z.boolean().default(true).describe("survey: add one agent that drops results it cannot confirm in the code."),
  models: z.object({
    scan: workflowSelectionSchema.optional(),
    verify: workflowSelectionSchema.optional(),
    combine: workflowSelectionSchema.optional(),
  }).strict().optional().describe("Per-stage overrides: a full {provider, model, reasoningLevel} or nothing."),
  runId: z.string().trim().min(1).optional().describe("Keep waiting on a run an earlier call started instead of starting a new one."),
}).superRefine((value, ctx) => {
  if (value.runId) return;
  const need = (field: string) => ctx.addIssue({ code: "custom", path: [field], message: `${field} is required${value.mode ? ` for ${value.mode}` : ""}` });
  if (!value.mode) need("mode");
  if (!value.question) need("question");
  if (value.mode === "survey" && !value.items) need("items");
  if (value.mode === "investigate" && !value.questions) need("questions");
});
type ResearchParams = z.infer<typeof researchParams>;

/** The one chief_research instruction line for a role, or null when the role has none or the switch is off. */
export function researchLine(role: string, settings: ResearchSettings | null) {
  const parsed = researchRoleSchema.safeParse(role);
  // A researcher's brief says how to use chief_research, so it gets no line.
  if (!parsed.success || parsed.data === "researcher" || !settings?.enabled) return null;
  const modes = RESEARCH_MODES[parsed.data].join(", ");
  return parsed.data === "chief"
    ? `Use chief_research (modes: ${modes}) for parallel read-only research; it runs in a child researcher thread and its report arrives as a lifecycle alert.`
    : `Use chief_research (modes: ${modes}) for parallel read-only research; it waits for the result.`;
}

/** Agent calls a fresh run needs; feeds the cap check. */
function agentCount(params: ResearchParams, combine: boolean) {
  if (params.mode === "investigate") return params.questions!.length + (combine ? 1 : 0);
  return Math.ceil(params.items!.length / params.batchSize) + (params.verify ? 1 : 0);
}

/** Inline workflow source. It reads only `args`, so no value is ever interpolated into it. */
export const RESEARCH_SCRIPTS = {
  survey: String.raw`export const meta = {
  name: "chief-research-survey",
  description: "Read-only survey: one question answered per item",
  phases: [{ title: "Scan" }, { title: "Verify" }],
};
const PRE = args.preamble + "\n\n";
const models = args.models || {};
const ROW = {
  type: "object",
  properties: { item: { type: "string" }, finding: { type: "string" }, evidence: { type: "string" } },
  required: ["item", "finding", "evidence"],
  additionalProperties: false,
};
const SCHEMA = { type: "object", properties: { rows: { type: "array", items: ROW } }, required: ["rows"], additionalProperties: false };
const size = Math.max(1, args.batchSize || 1);
const batches = [];
for (let i = 0; i < args.items.length; i += size) batches.push(args.items.slice(i, i + size));
const limit = Math.min(args.cap, budget().maxAgentCalls);
const needed = batches.length + (args.verify ? 1 : 0);
if (needed > limit) throw new Error("Survey needs " + needed + " agent calls; the limit is " + limit + ".");
const scanned = await parallel(batches.map((batch) => () => agent(
  PRE + "Question: " + args.question + "\n\nAnswer it for each item below, one row per item. Evidence is file:line or command output.\n" + batch.map((x) => "- " + x).join("\n"),
  Object.assign({ phase: "Scan", schema: SCHEMA }, models.scan || {}),
)));
let rows = [];
const missed = [];
scanned.forEach((result, i) => {
  if (result && result.rows) rows = rows.concat(result.rows);
  else missed.push(...batches[i]);
});
const failures = [];
const ok = scanned.filter((result) => result && result.rows).length;
if (missed.length) {
  log("No result for: " + missed.join(", "));
  failures.push("Scan: " + (batches.length - ok) + " of " + batches.length + " batches failed");
}
if (!ok) throw new Error("All " + batches.length + " scan batches failed; nothing to verify. See the failed calls for the provider error.");
const before = rows.length;
let verified = null;
let dropped = 0;
if (args.verify && rows.length) {
  let reason = "no rows returned";
  try {
    const checked = await agent(
      PRE + "Check each row against the code. Drop rows whose evidence does not support the finding; return the rest unchanged.\n\nQuestion: " + args.question + "\n\nRows:\n" + JSON.stringify(rows),
      Object.assign({ phase: "Verify", schema: SCHEMA }, models.verify || {}),
    );
    if (checked && checked.rows) { dropped = Math.max(0, before - checked.rows.length); rows = checked.rows; verified = true; }
  } catch (error) { reason = String((error && error.message) || error); }
  if (!verified) {
    verified = false;
    failures.push("Verify: " + reason);
    log("Verify failed (" + reason + "); returning " + before + " unverified rows.");
  }
}
const verifyNote = verified === true ? "; verify kept " + rows.length + ", dropped " + dropped + "." : verified === false ? "; verify failed, rows are UNVERIFIED." : "; not verified.";
const line = "Scanned " + before + " rows, " + ok + "/" + batches.length + " batches answered" + verifyNote + (missed.length ? " No result for: " + missed.join(", ") + "." : "");
const cell = (value) => String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = line + "\n\n" + ["| Item | Finding | Evidence |", "| --- | --- | --- |"]
  .concat(rows.map((r) => "| " + cell(r.item) + " | " + cell(r.finding) + " | " + cell(r.evidence) + " |"))
  .join("\n");
return { rows, table, missed, verified, dropped, failures };
`,
  investigate: String.raw`export const meta = {
  name: "chief-research-investigate",
  description: "Read-only investigation: one agent per question, merged into a brief",
  phases: [{ title: "Scan" }, { title: "Combine" }],
};
const PRE = args.preamble + "\n\n";
const models = args.models || {};
const ANSWER = {
  type: "object",
  properties: { answer: { type: "string" }, evidence: { type: "string" }, confirmed: { type: "boolean" } },
  required: ["answer", "evidence", "confirmed"],
  additionalProperties: false,
};
const combine = args.combine !== false;
const limit = Math.min(args.cap, budget().maxAgentCalls);
const needed = args.questions.length + (combine ? 1 : 0);
if (needed > limit) throw new Error("Investigation needs " + needed + " agent calls; the limit is " + limit + ".");
const scanned = await parallel(args.questions.map((q) => () => agent(
  PRE + "Goal: " + args.question + "\nQuestion: " + q + "\n\nAnswer it from the code. Evidence is file:line or command output. Set confirmed only when the evidence settles it.",
  Object.assign({ phase: "Scan", schema: ANSWER }, models.scan || {}),
)));
const answers = args.questions.map((q, i) => Object.assign({ question: q }, scanned[i] || { answer: "(no result)", evidence: "", confirmed: false }));
const failures = [];
const lost = scanned.filter((result) => !result).length;
if (lost) failures.push("Scan: " + lost + " of " + args.questions.length + " questions failed");
if (lost === args.questions.length) throw new Error("All " + lost + " question scans failed; skipped Combine. See the failed calls for the provider error.");
// The researcher thread that called this merges the answers itself.
if (!combine) return { answers, failures };
let brief = null;
let reason = "no brief returned";
try {
  brief = await agent(
    PRE + "Merge these answers into a short Markdown brief for: " + args.question + "\nUse two sections, ## Confirmed and ## Unconfirmed, keeping each answer's evidence.\n\nAnswers:\n" + JSON.stringify(answers),
    Object.assign({ phase: "Combine" }, models.combine || {}),
  );
} catch (error) { reason = String((error && error.message) || error); }
if (typeof brief !== "string") {
  const list = (confirmed) => answers.filter((a) => !!a.confirmed === confirmed).map((a) => "- **" + a.question + "** " + a.answer + " (" + a.evidence + ")").join("\n");
  brief = "Combine failed (" + reason + "); answers are unmerged.\n\n## Confirmed\n" + list(true) + "\n\n## Unconfirmed\n" + list(false);
  failures.push("Combine: " + reason);
  log("Combine failed (" + reason + "); returning unmerged answers.");
}
return { answers, brief, failures };
`,
} as const;

/** What chief_research reads of a managed_threads row; the server's ManagedRow satisfies it. */
interface ResearchRow {
  thread_id: string;
  role: string;
  state: string;
  project_id: string;
  title: string;
  created_at: number;
}

/** The server's closure values the research machinery uses. A value that changes at runtime (the role cache, the
 * settings) is passed as a function, never copied. Catalog is the server's per-host model-catalog reader. */
export interface ResearchDeps<Row extends ResearchRow, Catalog> {
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  bb: BbPluginApi;
  /** The caller's managed row, recovering a spawn-seeded one. */
  managedRow: (threadId: string, callerProjectId: string) => Promise<Row | undefined>;
  /** A row of the live role cache. */
  roleRow: (threadId: string) => Row | undefined;
  terminal: (state: string) => boolean;
  isActiveChief: (caller: Row | undefined) => boolean;
  /** A live settings read, never the cache. */
  researchSettings: () => Promise<ResearchSettings>;
  readResearchModel: (hostId: string, mode: ResearchMode) => ModelSelection | null;
  environmentHostId: (environmentId: string) => Promise<string | null | undefined>;
  discover: <T>(run: (signal: AbortSignal) => Promise<T>, label: string) => Promise<T>;
  catalogReader: (hostId: string) => Catalog;
  usableSelection: (hostId: string, selection: ModelSelection, read: Catalog) => Promise<ModelSelection | null>;
  anyCooldown: { get: (now: number) => unknown };
  cooldownError: (providerId: string, model: string) => Error | null;
  noteCooldown: (threadId: string, failure: { text: string; at: number }) => Promise<unknown>;
  lastProviderError: (threadId: string) => Promise<{ text: string; at: number } | null>;
  lastOutput: (threadId: string) => Promise<string | null | undefined>;
  /** The shared start-up recipe (section, rules, spawn, row, brief); the cooldown check stays in researchPrepare. */
  managedSpawn: ManagedSpawn<{
    threadId: string; role: "researcher"; projectId: string; chiefThreadId: string; parentThreadId: string;
    title: string; brief: string; state: "starting"; status: string;
  }>;
  alertChief: (row: Row, key: string, message: string) => Promise<unknown>;
  /** Writes one of Chief's artifacts and returns its absolute path. */
  writeArtifact: (threadId: string, projectId: string, name: string, content: string) => Promise<string>;
  serverPath: () => string;
  clip: (value: string, limit?: number) => string;
  execFileAsync: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
  maxResultLength: number;
}

/** One module owns the chief_research machinery: who may call it, the researcher child thread, the workflow run
 * and its waits, stops and timers. It returns the tool handler and the abortable sleep waitIdleAfterReport shares. */
export function createResearch<Row extends ResearchRow, Catalog>(deps: ResearchDeps<Row, Catalog>) {
  const {
    db, bb, managedRow, roleRow, terminal, isActiveChief, researchSettings, readResearchModel, environmentHostId, discover,
    catalogReader, usableSelection, anyCooldown, cooldownError, noteCooldown, lastProviderError, lastOutput, managedSpawn,
    alertChief, writeArtifact, serverPath, clip, execFileAsync,
    maxResultLength: MAX_RESULT_LENGTH,
  } = deps;

  /** Runs `bb workflows <sub>` as the calling thread: the CLI resolves its origin from these env vars. */
  async function runWorkflowCli(sub: string, args: string[], context: { threadId: string; projectId: string }) {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(process.env.BB_CLI ?? "bb", ["workflows", sub, ...args, "--json"], {
        env: { ...process.env, PATH: serverPath(), BB_THREAD_ID: context.threadId, BB_PROJECT_ID: context.projectId },
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch (error) {
      // With --json a failure still prints {"ok":false,"error":{…}} on stdout.
      const out = String((error as { stdout?: unknown }).stdout ?? "");
      const parsed = (() => { try { return JSON.parse(out); } catch { return null; } })();
      throw new Error(parsed?.error?.message ?? (error instanceof Error ? error.message : String(error)));
    }
    // `history` prints JSON Lines, one record per line; the other subcommands print one document.
    const parsed = (() => {
      try { return JSON.parse(stdout); } catch { return stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)); }
    })();
    if (parsed?.ok === false) throw new Error(parsed.error?.message ?? JSON.stringify(parsed.error));
    return parsed;
  }

  /** Who may call chief_research and in which mode. Throws the reason otherwise. */
  async function researchCaller(threadId: string, projectId: string, mode: z.infer<typeof researchModeSchema> | undefined, call: ResearchCall) {
    // Unmanaged threads (workflow agents included) have no row, which also stops recursion.
    const row = await managedRow(threadId, projectId);
    // The managed role is recorded as soon as it is known, so a rejected call is still attributed to it.
    if (row) call.role = row.role;
    if (!row || terminal(row.state)) throw new Error("chief_research is available only in an active Chief, planner, or researcher thread.");
    if (row.role === "chief" && !isActiveChief(row)) throw new Error("chief_research requires an active registered Chief thread.");
    const role = researchRoleSchema.safeParse(row.role);
    if (!role.success) throw new Error(`chief_research is not available to a managed ${row.role}.`);
    if (mode && !RESEARCH_MODES[role.data].includes(mode)) {
      throw new Error(`A ${role.data} may use chief_research modes ${RESEARCH_MODES[role.data].join(", ")}, not ${mode}.`);
    }
    const current = await researchSettings();
    if (!current.enabled) {
      throw new Error("chief_research is off in Chief settings → Chief researcher.");
    }
    return { row, role: role.data, cap: current.maxAgentCalls, settings: current };
  }

  /**
   * Per stage: a call override, else the caller machine's stored pick if it can still serve it, else inherit.
   * Workflow agents run in the caller's permission mode and the workflows host has no fallback, so a pick
   * whose provider cannot run that mode is dropped (that stage inherits) with a note.
   */
  async function researchModels(threadId: string, mode: ResearchMode, overrides: Partial<Record<Stage, WorkflowSelection>> = {}) {
    const live = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const hostId = live?.environmentId ? await environmentHostId(live.environmentId) : null;
    const stored = hostId ? readResearchModel(hostId, mode) : null;
    const usable = stored && hostId ? await usableSelection(hostId, stored, catalogReader(hostId)) : null;
    let pick: WorkflowSelection | null = usable ? { provider: usable.providerId, model: usable.model, reasoningLevel: usable.reasoningLevel } : null;
    const callerOptions = await bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
    const callerMode = callerOptions?.permissionMode ?? null;
    const caller = live?.providerId ? { providerId: live.providerId, model: callerOptions?.model ?? "" } : null;
    const providers = hostId && callerMode
      ? await discover((signal) => bb.sdk.providers.list({ hostId, signal }), "Provider discovery").catch(() => null)
      : null;
    const notes: string[] = [];
    // Fails open: an unknown mode or capability list keeps the pick, as the host does for spawns.
    const misfit = (selection: WorkflowSelection, label: string) => {
      const modes = providers?.find((provider) => provider.id === selection.provider)?.capabilities?.permissionModes;
      if (!callerMode || !modes || modes.includes(callerMode)) return false;
      notes.push(`Researcher ${label} ${selection.provider}/${selection.model} cannot run in this thread's permission mode "${callerMode}" (it supports ${modes.join(", ")}); its stages used your model.`);
      return true;
    };
    if (pick && misfit(pick, `${mode} model`)) pick = null;
    const models: Partial<Record<Stage, WorkflowSelection>> = {};
    for (const stage of stageSchema.options) {
      const override = overrides[stage];
      const chosen = override && !misfit(override, `${stage} override`) ? override : pick;
      if (chosen) models[stage] = chosen;
    }
    for (const note of notes) bb.log.warn(note);
    // A researcher child runs on `pick` (the mode's own pick, never a per-call override), else on Chief's own model.
    const own = live?.providerId && callerOptions?.model
      ? { providerId: live.providerId, model: callerOptions.model, reasoningLevel: callerOptions.reasoningLevel }
      : null;
    return { models, notes, hostId, caller, pick, own, environmentId: live?.environmentId ?? null, permissionMode: callerMode };
  }

  /** Why the run cannot start (a provider signed out or at 100% of a usage window), or null. */
  async function researchPreflight(hostId: string, providerIds: string[]) {
    // ponytail: fails open (missing key, error, throw, timeout) because not every provider reports usage.
    for (const providerId of new Set(providerIds)) {
      const res = await discover(async (signal) => bb.sdk.system.usageLimits({ hostId, providerId, signal }), "Usage check").catch(() => null);
      const usage = (res as Record<string, any> | null)?.[providerId];
      if (usage?.status === "not_installed" || usage?.status === "unauthenticated" || usage?.status === "expired") return `${providerId} is ${usage.status}`;
      const full = usage?.status === "ok" ? usage.windows?.find((w: { usedPercent: number }) => w.usedPercent >= 100) : null;
      if (full) return `${providerId} is out of quota (${full.label} window at ${full.usedPercent}%${full.resetsAt ? `, resets ${full.resetsAt}` : ""})`;
    }
    return null;
  }

  /** Waits for abortable sleeps; an abort rejects with the signal's reason. */
  function researchSleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
      const stop = () => { clearTimeout(timer); reject(signal!.reason); };
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  function researchOutput(text: string) {
    if (text.length <= MAX_RESEARCH_OUTPUT) return text;
    const tail = "\n…clipped. Read the full result with `bb workflows history <runId> --cursor 0 --limit 1`.";
    return text.slice(0, MAX_RESEARCH_OUTPUT - tail.length) + tail;
  }

  /** The workflows plugin's run statuses are queued, running, succeeded, failed, and cancelled. */
  const RUNNING_WORKFLOW = new Set(["queued", "running"]);

  /** Polls a run until it finishes or waitMs passes, then says what happened; the run keeps going either way. */
  /** One line naming the failed agent calls and the first one's real reason (e.g. a quota error). Best-effort: null on any trouble. */
  async function failureNote(runId: string, context: { threadId: string; projectId: string }) {
    try {
      const history: unknown = await runWorkflowCli("history", [runId, "--cursor", "0", "--limit", "100"], context);
      const failed = (Array.isArray(history) ? history : [history])
        .filter((record) => record?.type === "call" && record.status === "failed") as { phase?: string; childThreadId?: string }[];
      if (!failed.length) return null;
      const counts = new Map<string, number>();
      for (const call of failed) counts.set(call.phase ?? "?", (counts.get(call.phase ?? "?") ?? 0) + 1);
      const first = failed[0];
      if (first.childThreadId) {
        const failure = await lastProviderError(first.childThreadId);
        if (failure) await noteCooldown(first.childThreadId, failure);
      }
      const output = first.childThreadId ? await lastOutput(first.childThreadId) : null;
      return `Failed agent calls: ${[...counts].map(([phase, n]) => `${phase} ×${n}`).join(", ")}. First failure (${first.phase ?? "?"}, thread ${first.childThreadId ?? "?"}): ${output ? clip(output, 300) : "(no output)"}`;
    } catch {
      return null;
    }
  }

  /** runWorkflowCli with 3 tries 1 s apart, for reads whose single failure would drop a run or its answers. */
  async function workflowRead(sub: string, args: string[], context: { threadId: string; projectId: string }) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await runWorkflowCli(sub, args, context);
      } catch (error) {
        if (attempt >= 3) throw error;
        await researchSleep(1_000);
      }
    }
  }

  /** Stops a run and confirms it ended, retrying; returns why it could not, or null. Never throws. */
  async function stopResearch(runId: string, context: { threadId: string; projectId: string }) {
    let reason = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      let stopError = "";
      await runWorkflowCli("stop", [runId], context).catch((error) => { stopError = clip(error instanceof Error ? error.message : String(error), 200); });
      try {
        const run = await runWorkflowCli("status", [runId], context);
        if (!RUNNING_WORKFLOW.has(run.status)) return null;
        reason = `the run is still ${run.status} after stop${stopError ? ` (stop: ${stopError})` : ""}`;
      } catch (error) {
        reason = stopError || clip(error instanceof Error ? error.message : String(error), 200);
      }
      await researchSleep(1_000);
    }
    bb.log.warn(`chief_research could not stop ${runId}: ${reason}`);
    return reason;
  }

  /**
   * The answers of every agent call that finished, for a partial report; null when history is unreadable.
   * `next` is the history cursor to continue from when the list stops short (1,000 records or a failed page).
   */
  async function finishedAnswers(runId: string, context: { threadId: string; projectId: string }) {
    const done: { phase?: string; result?: unknown }[] = [];
    let next: number | null = null;
    let readError = "";
    for (let cursor = 0, pages = 0; ; pages++) {
      let records: { type?: string; status?: string; phase?: string; result?: unknown; hasMore?: boolean; nextCursor?: number }[];
      try {
        const lines: unknown = await workflowRead("history", [runId, "--cursor", String(cursor), "--limit", "100"], context);
        records = (Array.isArray(lines) ? lines : [lines]) as typeof records;
      } catch (error) {
        if (!pages) return null;
        next = cursor;
        readError = clip(error instanceof Error ? error.message : String(error), 200);
        break;
      }
      done.push(...records.filter((record) => record?.type === "call" && record.status === "succeeded"));
      const page = records.find((record) => record?.type === "page");
      if (!page?.hasMore || typeof page.nextCursor !== "number") break;
      cursor = page.nextCursor;
      if (pages + 1 >= 10) { next = cursor; break; }
    }
    return { answers: done.map((record) => ({ phase: record.phase, result: record.result })), next, readError };
  }

  /**
   * A researcher run's hard stop, kept by the server so it does not depend on the child resuming. A failed stop
   * alerts Chief and re-arms. ponytail: 5 rounds 30 s apart, then the alert is the escalation; timers are per
   * process (a restart waits for the child's next call to re-arm), persist them if that ever matters.
   */
  const RESEARCH_STOP_ROUNDS = 5;
  const researchStops = new Map<string, ReturnType<typeof setTimeout>>();
  function armResearchStop(runId: string, at: number, context: { threadId: string; projectId: string }, round = 0) {
    if (!round && researchStops.has(runId)) return;
    const timer = setTimeout(async () => {
      try {
        // No status gate: stopping a finished run is a no-op, and stopResearch confirms the status itself.
        const failure = await stopResearch(runId, context);
        if (researchStops.get(runId) !== timer) return; // disarmed or re-armed meanwhile
        if (!failure) return void researchStops.delete(runId);
        const row = roleRow(context.threadId);
        if (row) {
          await alertChief(row, `research-stop:${runId}`, [
            `Researcher “${row.title}” (${row.thread_id}): workflow ${runId} passed its time limit and could not be stopped (${failure}). It may still be running.`,
            `The server retries ${RESEARCH_STOP_ROUNDS - round - 1} more times. Check it with \`bb workflows status ${runId}\` and stop it with \`bb workflows stop ${runId}\`.`,
          ].join("\n"));
        }
        if (round + 1 < RESEARCH_STOP_ROUNDS) armResearchStop(runId, Date.now() + 30_000, context, round + 1);
        else researchStops.delete(runId);
      } catch (error) {
        // An alert that could not even be queued (no Chief) must not end the retries.
        bb.log.warn(`chief_research deadline stop for ${runId} failed: ${clip(String(error), 200)}`);
        if (researchStops.get(runId) === timer) {
          if (round + 1 < RESEARCH_STOP_ROUNDS) armResearchStop(runId, Date.now() + 30_000, context, round + 1);
          else researchStops.delete(runId);
        }
      }
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    researchStops.set(runId, timer);
  }
  function disarmResearchStop(runId: string) {
    clearTimeout(researchStops.get(runId));
    researchStops.delete(runId);
  }

  /** What a researcher gets once its run passed the time limit: stop status, failures and the answers that finished. */
  async function timedOutReport(runId: string, mode: string, stopFailure: string | null, context: { threadId: string; projectId: string }) {
    const [note, answers] = await Promise.all([failureNote(runId, context), finishedAnswers(runId, context)]);
    return researchOutput([
      `runId: ${runId}`, "status: timed_out",
      `failures: the ${mode} run passed its time limit and ${stopFailure ? `COULD NOT BE STOPPED (${stopFailure}); it may still be running. Report blocked with that as the blocker and tell Chief to run \`bb workflows stop ${runId}\`` : "was stopped"}. Report the finished answers below as partial, saying it timed out.`,
      ...(note ? [note] : []),
      "", "finished answers:",
      // The marker sits above the JSON: researchOutput clips the tail, which is where a long list would push it.
      ...(answers?.next != null ? [`(list truncated${answers.readError ? ` after a history read failed: ${answers.readError}` : " at 1,000 history records"}; read the rest with \`bb workflows history ${runId} --cursor ${answers.next} --limit 100\`)`] : []),
      answers ? (answers.answers.length ? JSON.stringify(answers.answers, null, 2) : "(none finished)") : `(could not read history; try \`bb workflows history ${runId}\`)`,
    ].join("\n"));
  }

  /** What a chief_research call ended as, mutated by research()'s paths and written once to chief_research_calls. */
  type ResearchCall = { role: string | null; runId: string | null; outcome: "succeeded" | "partial" | "failed" | "still_running" | "timed_out" | "spawned" | "start_failed" | "error" };

  type RunStatus = { status: string; result?: unknown; resultOmitted?: boolean; error?: unknown; calls?: unknown; finishedAt?: number };

  /** The unclipped text of a finished run: succeeded (or partial) with its result, else failed with its error. */
  async function resultText(runId: string, run: RunStatus, context: { threadId: string; projectId: string }): Promise<{ outcome: "succeeded" | "partial" | "failed"; text: string }> {
    if (run.status === "succeeded") {
      let result = run.result;
      if (run.resultOmitted) {
        const history: unknown = await workflowRead("history", [runId, "--cursor", "0", "--limit", "1"], context).catch(() => null);
        const record = (Array.isArray(history) ? history : [history]).find((line) => line?.type === "run");
        result = record?.result ?? "(result omitted; read it with bb workflows history)";
      }
      // survey's table or investigate's brief, shown above the raw result.
      const shown = result as { table?: unknown; brief?: unknown } | null;
      const summary = [shown?.table, shown?.brief].find((value) => typeof value === "string");
      const failures = (result as { failures?: unknown } | null)?.failures;
      const partial = Array.isArray(failures) && failures.length > 0;
      const note = partial ? await failureNote(runId, context) : null;
      return {
        outcome: partial ? "partial" : "succeeded",
        text: [
          `runId: ${runId}`, `status: ${partial ? "partial" : run.status}`, ...(note ? [note] : []),
          ...(summary ? ["", summary as string] : []),
          "", "result:", JSON.stringify(result, null, 2),
        ].join("\n"),
      };
    }
    const note = await failureNote(runId, context);
    return { outcome: "failed", text: `runId: ${runId}\nstatus: ${run.status}\nerror: ${JSON.stringify(run.error)}\n${note ? `${note}\n` : ""}calls: ${JSON.stringify(run.calls)}` };
  }

  async function awaitResearch(runId: string, context: { threadId: string; projectId: string; signal?: AbortSignal }, deadline: number, call: ResearchCall, hard?: { at: number; mode: string }) {
    call.runId = runId;
    if (hard) armResearchStop(runId, hard.at, context);
    try {
      for (;;) {
        let run: RunStatus;
        try {
          run = await workflowRead("status", [runId], context);
        } catch (error) {
          context.signal?.throwIfAborted();
          bb.log.warn(`chief_research could not read ${runId}: ${clip(String(error), 200)}`);
          if (!hard) {
            call.outcome = "error";
            return `Could not read workflow ${runId} from the plugin server. Check it yourself with \`bb workflows status ${runId}\`.`;
          }
          run = { status: "running" }; // unknown is not finished: keep waiting, and past the deadline the stop path still runs
        }
        if (!RUNNING_WORKFLOW.has(run.status)) disarmResearchStop(runId);
        if (run.status === "succeeded") {
          const { outcome, text } = await resultText(runId, run, context);
          call.outcome = outcome;
          return researchOutput(text);
        }
        // Cancelled past the deadline is the hard stop (the server's timer or an earlier call), not a failure.
        if (hard && run.status === "cancelled" && Date.now() >= hard.at) {
          call.outcome = "timed_out";
          return timedOutReport(runId, hard.mode, null, context);
        }
        if (!RUNNING_WORKFLOW.has(run.status)) {
          const { outcome, text } = await resultText(runId, run, context);
          call.outcome = outcome;
          return researchOutput(text);
        }
        context.signal?.throwIfAborted();
        // The hard deadline comes first: when both have passed, the run is over, not "still running".
        if (hard && Date.now() >= hard.at) {
          const stopFailure = await stopResearch(runId, context);
          // A run that finished between the status read and the stop is a result, not a timeout.
          if ((await workflowRead("status", [runId], context).catch(() => null))?.status === "succeeded") continue;
          call.outcome = "timed_out";
          return timedOutReport(runId, hard.mode, stopFailure, context);
        }
        if (Date.now() >= deadline) {
          call.outcome = "still_running";
          return `Still running. Call chief_research again with ${hard ? `mode: ${hard.mode} and ` : ""}runId: ${runId} to keep waiting.`;
        }
        await researchSleep(RESEARCH_POLL_MS, context.signal);
      }
    } catch (error) {
      if (context.signal?.aborted) {
        await stopResearch(runId, context); // no alert: an abort is the caller's own cancellation
      }
      throw error;
    }
  }

  async function research(params: ResearchParams, context: { threadId: string; projectId: string; signal?: AbortSignal }) {
    const startedAt = Date.now();
    // Every exit, caller check and settings read included, thrown or returned, leaves exactly one chief_research_calls row.
    const call: ResearchCall = { role: null, runId: params.runId ?? null, outcome: "error" };
    try {
      const { cap, settings, role, row } = await researchCaller(context.threadId, context.projectId, params.mode, call);
      return await researchRun(params, context, { startedAt, cap, settings, role, row }, call);
    } finally {
      try {
        db.prepare(`INSERT INTO chief_research_calls (caller_thread_id, role, mode, run_id, outcome, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(context.threadId, call.role, params.mode ?? null, call.runId, call.outcome, startedAt, Date.now());
      } catch (error) {
        bb.log.warn(`Could not record chief_research call: ${String(error)}`);
      }
    }
  }

  /** Cap, model, cooldown and quota checks, and the script and args of a fresh run. Throws the reason it cannot start. */
  async function researchPrepare(params: ResearchParams, threadId: string, cap: number, combine: boolean, spawn = false) {
    const mode = params.mode!;
    const calls = agentCount(params, combine);
    if (calls > cap) {
      const fix = mode === "survey" ? "Raise batchSize or split the items." : "Ask fewer questions.";
      throw new Error(`This ${mode} needs ${calls} agent calls; the limit is ${cap}. ${fix}`);
    }
    const found = await researchModels(threadId, mode, params.models);
    const { models, notes, hostId, caller } = found;
    // The stages that execute, and for a spawn the thread that will run them: the mode's pick, else Chief's own model.
    const stages: Stage[] = ["scan", ...(mode !== "investigate" && params.verify ? ["verify" as const] : []), ...(mode === "investigate" && combine ? ["combine" as const] : [])];
    const child = spawn
      ? found.pick ? { providerId: found.pick.provider, model: found.pick.model, reasoningLevel: found.pick.reasoningLevel } : found.own
      : null;
    if (spawn && !child) {
      throw new Error("chief_research did not start: Chief's own provider and model could not be read, so the researcher thread cannot be pinned to them. Retry, or set a researcher model for this mode in Chief settings.");
    }
    if (anyCooldown.get(Date.now())) {
      const targets = [...stages.map((stage) => { const chosen = models[stage]; return chosen ? { providerId: chosen.provider, model: chosen.model } : caller; }), child];
      for (const target of targets) {
        const cooling = target ? cooldownError(target.providerId, target.model) : null;
        if (cooling) throw cooling;
      }
    }
    const providerIds = [...stages.map((stage) => models[stage]?.provider ?? caller?.providerId), child?.providerId].filter((id): id is string => !!id);
    const blocked = hostId ? await researchPreflight(hostId, providerIds) : null;
    if (blocked) throw new Error(`chief_research did not start: ${blocked}. Pick another researcher model in Chief settings or retry after the reset.`);
    const args = {
      preamble: RESEARCH_PREAMBLE, question: params.question, verify: params.verify, cap, combine,
      models,
      ...(mode === "survey" ? { items: params.items, batchSize: params.batchSize } : {}),
      ...(mode === "investigate" ? { questions: params.questions } : {}),
    };
    // Without Combine the Combine phase would sit empty in the run view.
    const script = combine ? RESEARCH_SCRIPTS[mode] : RESEARCH_SCRIPTS[mode].replace(', { title: "Combine" }]', "]");
    return { ...found, child, script, args, prefix: notes.length ? notes.join("\n") + "\n\n" : "" };
  }

  /**
   * Chief's chief_research: the researcher runs in a child thread on Chief's own checkout. Everything that can
   * be refused (cap, cooldown, quota, no shareable checkout) is refused here, before a thread exists.
   */
  async function startResearcher(params: ResearchParams, chief: Row, cap: number) {
    const prepared = await researchPrepare(params, chief.thread_id, cap, false, true);
    // The child reads Chief's working tree, so it must reuse Chief's environment: no fresh worktree fallback.
    if (!prepared.environmentId) {
      throw new Error("chief_research did not start: Chief's checkout cannot be shared with a researcher thread (this thread has no reusable environment).");
    }
    const mode = params.mode!;
    const managed = await managedSpawn.prepare(chief.project_id, { execution: prepared.child! });
    const title = `Research · ${mode} · ${clip(params.question!, 60)}`;
    const { runId: _runId, ...call } = params;
    const prompt = [
      `You are the managed researcher for a ${mode} requested by Chief thread ${chief.thread_id}. Report to that Chief.`,
      "", "## Question", params.question!,
      "", "## Working contract",
      `- ${RESEARCH_ONLY}`,
      "- Call chief_research once with exactly these parameters:",
      "```json", JSON.stringify(call), "```",
      `- If it answers "Still running", call chief_research again with mode: ${mode} and the runId it gave; repeat until it returns the result, fails, or reports timed_out. Never start a second run for the same question.`,
      "- If chief_research fails with a tool error, call it again with mode and runId; do not poll with bb workflows commands.",
      "- timed_out means the run was stopped at its time limit: the response lists the answers that finished. Report those as a partial result, saying it timed out. If the response says the stop failed, report blocked with that as the blocker.",
      ...({
        survey: ["- Merge: one table with every row and its evidence."],
        investigate: ["- An investigate result has the scanned answers but no brief: merge them yourself into a brief with ## Confirmed (each with its evidence) and ## Unconfirmed sections."],
      }[mode]),
      "- Check nothing new in the code yourself beyond reconciling conflicting answers. Keep every listed failure, and say the result is partial when there are failures or the run timed out.",
      `- Report with chief_report state ready (blocked only when the run could not start or the stop failed): \`result\` is the full report within ${MAX_RESULT_LENGTH} characters, with the runId on its first line, and \`summary\` at most 800 characters. When nothing usable came back, report blocked with the cause as blocker and your recommended next step as recommendation.`,
      "- Do not ask the user directly from this thread.",
    ].join("\n");
    const thread = await managedSpawn.launch(managed, {
      projectId: chief.project_id,
      environment: { type: "reuse", environmentId: prepared.environmentId },
      title, prompt,
      extra: prepared.permissionMode ? { permissionMode: prepared.permissionMode } : {},
      onSpawnError: (error) => new Error(`chief_research did not start: BB could not run a researcher thread in Chief's checkout (${clip(error instanceof Error ? error.message : String(error), 200)}). Nothing was started in a fresh worktree.`),
    }, { role: "researcher", chiefThreadId: chief.thread_id, brief: prompt });
    return { threadId: thread.id, title, prefix: prepared.prefix };
  }

  async function researchRun(
    params: ResearchParams,
    context: { threadId: string; projectId: string; signal?: AbortSignal },
    { startedAt, cap, settings, role, row }: { startedAt: number; cap: number; settings: Awaited<ReturnType<typeof researchSettings>>; role: ResearchRole; row: Row },
    call: ResearchCall,
  ) {
    const waitMs = (params.mode ? settings.timeoutMinutes[params.mode] : RESEARCH_DEFAULT_TIMEOUT_MINUTES) * 60_000;
    let deadline = startedAt + Math.min(waitMs, RESEARCH_CALL_WAIT_CAP_MS);
    // A researcher keeps re-calling until the run ends, so the mode's timeout bounds the whole run, counted from its spawn.
    let hard: { at: number; mode: string } | undefined;
    if (role === "researcher") {
      if (!params.mode) throw new Error("A researcher resumes with mode and runId together.");
      hard = { at: row.created_at + waitMs, mode: params.mode };
      deadline = Math.min(deadline, hard.at);
    }
    if (params.runId) return awaitResearch(params.runId, context, deadline, call, hard);
    if (role === "chief") {
      const started = await startResearcher(params, row, cap);
      call.outcome = "spawned";
      return `${started.prefix}Started researcher thread ${started.threadId} (${started.title}). It runs the ${params.mode} in your checkout and reports through chief_report; the report arrives as a lifecycle alert. Do not poll: end your turn.`;
    }
    const prepared = await researchPrepare(params, context.threadId, cap, role !== "researcher");
    const { script, args, prefix } = prepared;
    let runId: string;
    try {
      const started = await runWorkflowCli("run", ["--script", script, "--args", JSON.stringify(args)], context);
      if (typeof started?.runId !== "string") throw new Error("bb workflows run returned no runId");
      runId = started.runId;
      call.runId = runId;
    } catch (error) {
      const failure = clip(error instanceof Error ? error.message : String(error), 200);
      bb.log.warn(`chief_research could not start a workflow from the server: ${failure}`);
      call.outcome = "start_failed";
      return prefix + [
        `The plugin server could not start the workflow (${failure}), so start it yourself:`,
        "call bb_workflow_run with exactly this script and args, then call chief_research with mode and the runId it returns to wait for the result.",
        "", "script:", "```js", script, "```", "", "args:", "```json", JSON.stringify(args), "```",
      ].join("\n");
    }
    return prefix + await awaitResearch(runId, context, deadline, call, hard);
  }

  const unreadCounts = new Map<string, number>();
  const firstSeenEnded = new Map<string, number>();
  const IDLE_STATES = new Set(["ready", "blocked", "complete", "archived", "deleted"]);

  /** Supervisor check: a researcher whose run ended without a report gets its result saved and Chief alerted, once per run. */
  async function checkUnreported(rows: Row[]) {
    for (const row of rows) {
      if (row.role !== "researcher" || IDLE_STATES.has(row.state)) continue;
      try {
        const last = db.prepare<[string]>(`SELECT run_id FROM chief_research_calls WHERE caller_thread_id=? AND run_id IS NOT NULL ORDER BY id DESC LIMIT 1`)
          .get(row.thread_id) as { run_id: string } | undefined;
        if (!last) continue;
        const runId = last.run_id;
        // The outbox row survives a reload, so it is the once-per-run marker.
        if (db.prepare<[string]>(`SELECT 1 FROM alert_outbox WHERE dedupe_key=?`).get(`${row.thread_id}:research-unreported:${runId}`)) continue;
        const context = { threadId: row.thread_id, projectId: row.project_id };
        let run: RunStatus;
        try {
          run = await runWorkflowCli("status", [runId], context); // one try: the next supervisor tick is the retry
          unreadCounts.delete(runId);
        } catch (error) {
          const failures = (unreadCounts.get(runId) ?? 0) + 1;
          unreadCounts.set(runId, failures);
          if (failures === RESEARCH_UNREAD_LIMIT) {
            await alertChief(row, `research-unread:${runId}`, [
              `Researcher "${row.title}" (${row.thread_id}): the plugin server could not read its run ${runId} ${failures} times in a row: ${clip(error instanceof Error ? error.message : String(error), 300)}`,
              `Check it with \`bb workflows status ${runId}\`.`,
            ].join("\n"));
          }
          continue;
        }
        if (RUNNING_WORKFLOW.has(run.status)) continue;
        if (!firstSeenEnded.has(runId)) firstSeenEnded.set(runId, Date.now());
        const finishedAt = typeof run.finishedAt === "number" ? run.finishedAt : firstSeenEnded.get(runId)!;
        if (Date.now() - finishedAt < RESEARCH_REPORT_GRACE_MS) continue;
        const { text } = await resultText(runId, run, context);
        const path = await writeArtifact(row.thread_id, row.project_id, `research-${runId}.md`, `${text}\n`).catch((error) => {
          bb.log.warn(`checkUnreported could not save ${runId}: ${clip(String(error), 200)}`);
          return null;
        });
        const output = await lastOutput(row.thread_id).catch(() => null);
        await alertChief(row, `research-unreported:${runId}`, [
          `Researcher "${row.title}" (${row.thread_id}): run ${runId} is ${run.status}; it finished ${Math.round((Date.now() - finishedAt) / 60_000)} min ago and the researcher has not reported.`,
          path ? `Result saved to ${path}` : `The result could not be saved; read it with \`bb workflows history ${runId} --cursor 0 --limit 1\`.`,
          `Last assistant output:\n${output ? clip(output, 2_000) : "(none available)"}`,
          "If that output shows it writing its report, wait; otherwise chief_stop it and use the result.",
        ].join("\n"));
      } catch (error) {
        // alertChief threw before its outbox row landed, or a DB read failed: the next tick retries this row.
        bb.log.warn(`checkUnreported failed for ${row.thread_id}: ${clip(String(error), 200)}`);
      }
    }
  }

  return { research, researchSleep, checkUnreported };
}
