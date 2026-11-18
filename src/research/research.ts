import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { worktreeEnvironment, type ManagedSpawn } from "./managedSpawn";
import type { ThreadInsert } from "../db/threadStore";
import { type ManagedRow, type ModelSelection } from "../types";
import { READ_ONLY, RESEARCH_ONLY } from "../core/roles";

export { modelSelectionSchema, type ModelSelection } from "../types";

// shortcut: fixed helper cap; make it a setting if users ask
export const RESEARCH_MAX_HELPERS = 6;

export const researchSettingsSchema = z.object({ enabled: z.boolean() });
export type ResearchSettings = z.infer<typeof researchSettingsSchema>;
export const researchSettingsPatchSchema = z.object({ enabled: z.boolean().optional() }).strict();
/** One flat object: tool parameters must publish as a JSON Schema of type object. */
export const researchParams = z.object({
  question: z.string().trim().min(1).max(4_000).describe("The ticket: the issue text or the user's request in full. With no ticket, your question is the ticket."),
  design: z.boolean().describe("true: research, then a design discussion with the user in the researcher thread, ending in a design.md the user approved (features and multi-file work). false: facts only (evidence checks such as a doubtful worker or reviewer claim)."),
  branch: z.string().trim().min(1).max(300).optional().describe("Run the researcher in a fresh worktree on this branch instead of your checkout."),
});
type ResearchParams = z.infer<typeof researchParams>;

/** The one chief_research instruction line: Chief's, while the switch is on. */
export function researchLine(role: string, settings: ResearchSettings | null) {
  return role === "chief" && settings?.enabled ? "Use chief_research for read-only research by a researcher thread." : null;
}

/** A researcher's prompt: ticket-blind helper research (stages 1-2), and with design a user-approved design.md (stage 3). */
export function researcherBrief(input: {
  chiefThreadId: string; question: string; design: boolean; execution: Partial<ModelSelection>; permissionMode?: string | null; maxResultLength: number;
}) {
  const { chiefThreadId, question, design, execution, permissionMode, maxResultLength } = input;
  const pinned = execution.providerId && execution.model;
  const spawn = [
    `bb thread spawn --project "$BB_PROJECT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --environment "$BB_ENVIRONMENT_ID"`,
    ...(pinned ? [`--provider ${execution.providerId} --model ${execution.model}${execution.reasoningLevel ? ` --reasoning-level ${execution.reasoningLevel}` : ""}`] : []),
    ...(permissionMode ? [`--permission-mode ${permissionMode}`] : []),
    `--title "Research helper: <part>" --prompt-file - --json <<'EOF' … EOF`,
  ].join(" ");
  const design_md = "`$BB_THREAD_STORAGE/design.md`";
  const waiting = "chief_report state `active`, `waitingOnUser: true`, result `Design discussion: waiting on the user. Design: <absolute design.md path>`";
  return [
    `You are the managed researcher for Chief thread ${chiefThreadId}. Report to that Chief.`,
    "", "## Ticket", "With no separate ticket, this is the ticket.", question,
    "", "## Working contract",
    `- ${RESEARCH_ONLY}`,
    "- Stage 1, Context: read the ticket, then write neutral research questions about how the code works today (for example \"how do endpoints work\", \"trace the flow for X\", \"find the workers that handle Y\"). A question never names the goal or the proposed change and never uses should, fix, add or better. Do not show the questions to the user.",
    `- Stage 2, Research: group the questions into vertical slices and spawn one helper per slice, at least 1 and at most ${RESEARCH_MAX_HELPERS}. Do not answer the questions yourself before the helpers report.`,
    `- Spawn a helper with: ${spawn}`,
    ...(pinned ? [] : ["- Helpers run on BB's default model for this project, as you do: pass no --provider or --model."]),
    "- The helper id is `.id` of the output.",
    `- Each helper prompt contains only: the read-only rule (${READ_ONLY}; run no command that changes tracked files or git state; you share the caller's checkout), its questions, the fact format (per question, facts each with file:line evidence, then \`## Unconfirmed\`), \`Report facts only: no advice, no recommendations, no opinion on what should change.\`, and \`Do not spawn threads. Your final message is your answer.\` It never contains the ticket, its title, the goal or words from the ticket's proposed change.`,
    "- Wait for each helper with `bb thread wait <id> --status idle --timeout 540s` as a foreground call (tool timeout 570000 ms). Read its answer with `bb thread output <id>`. A helper that failed or is still not idle after a second wait: `bb thread stop <id>`, and list it as a failure. Never poll with sleep loops.",
    "- While a helper runs, run no git command that changes this checkout (fetch, checkout, reset).",
    "- Merge the answers into the fact report: `## Facts` (question, then its facts with file:line) and `## Unconfirmed`. Check each kept fact against the code, and drop or move to Unconfirmed any fact whose evidence does not hold. Name each failed or stopped helper, and say the report is partial when a question has no answer. No recommendations.",
    "- Before you report, stop any helper still running.",
    ...(design ? [
      `- Stage 3, Design: write ${design_md} (about 200 lines, at most 40,000 characters; rewrite it in place, never version it) with \`## Current state\`, \`## Desired end state\`, \`## Patterns to follow\` (file:line; name any competing pattern and why you picked one), \`## Resolved decisions\`, \`## Open questions\` (numbered Q1…, each with options and your recommended answer). Post its absolute path as a Markdown link in your thread.`,
      `- Waiting: right before your first AskUserQuestion call of the discussion, call ${waiting}. Report this again only after you left waiting (after a rejection restart or a blocked fallback), never per round.`,
      "- Rounds: ask the open questions with AskUserQuestion, at most 4 questions per call, 2-4 options each; split a bigger round into sequential calls; number across the round (Q1, Q2…); put the recommended option first with a label ending ` (Recommended)`. After each round rewrite design.md in place (answers into Resolved decisions, new questions added).",
      "- Rejection: if the user rejects the whole direction, first call chief_report state `active` (no waitingOnUser) with result `Research restarted: the user rejected the design direction.`, then go back to stage 1 in this thread (new neutral questions, fresh helpers); report waiting again when the new design.md is ready.",
      `- Exit: stage 3 ends only on the user's explicit approval: the last call asks for approval and an approve option is the only exit. Then report with chief_report state ready: \`result\` within ${maxResultLength} characters, lines \`Helpers: <n>\`, \`Design: <absolute design.md path>\`, then the fact report (Unconfirmed included); \`summary\` at most 800 characters.`,
      "- Fallback: when AskUserQuestion is not offered, or a call returns an error, a timeout or a dismissal, never proceed on your own judgment and never take silence as approval. Write the full round into design.md `## Open questions` (numbered, options, recommended answer), then report `blocked` with `waitingOnUser: true`: blocker first line `Design questions (round <n>): <absolute design.md path>` followed by the questions, recommendation = the recommended answer per question; end your turn. The user answers in this thread; continue the same round from that answer (approval included). When you next ask through AskUserQuestion, report the waiting `active` report again.",
      "- When nothing usable came back from research, report blocked with the cause as blocker and your recommended next step as recommendation.",
      "- Ask the user only your design questions, through AskUserQuestion in stage 3 or the blocked fallback above; never ask anything else.",
    ] : [
      `- Report with chief_report state ready: \`result\` is the full report within ${maxResultLength} characters, \`summary\` at most 800 characters, and the first line of result says \`Helpers: <n>\`, then the fact report. When nothing usable came back, report blocked with the cause as blocker and your recommended next step as recommendation.`,
      "- Do not ask the user directly from this thread.",
    ]),
  ].join("\n");
}

/** A researcher's next-action line for the alert and chief_roster Pending, or null for the shared fallback. */
export function researcherNextLine(row: ManagedRow, planning: boolean): string | null {
  const id = row.thread_id;
  if (row.waiting_on_user === 1 && row.state === "active") {
    return `Design discussion: researcher ${id} is asking the user its design questions in @thread:${id}. If you have not told the user since its last report, tell them in one line that the discussion waits on them there; then end your turn. Do not poll, nudge or stop it: it has no timeout and its stall alerts are muted.`;
  }
  if (row.waiting_on_user === 1 && row.state === "blocked") {
    return `Its design questions could not be asked in its thread. Read the full round in the design.md named on its blocker's first line (the alert clips it), then call chief_escalate (threadId ${id}, request: that round verbatim with the recommended answers and @thread:${id}), write it under Need you, and ask the user to answer in that researcher thread; the researcher continues there. Do not answer them yourself.`;
  }
  if (row.research_design !== 1) return null;
  if (row.state === "active") return "Progress only: the researcher restarted research; nothing to do. End your turn.";
  if (row.state === "ready") {
    return planning
      ? "The user approved the design (the Design: line above). Plan it: chief_plan with the Design: path and the fact report in context."
      : "The user approved the design (the Design: line above). Delegate it: chief_delegate with the Design: path and the fact report in context.";
  }
  return null;
}

/** The server's closure values the research machinery uses. A value that changes at runtime (the settings) is passed as a function, never copied. */
export interface ResearchDeps {
  db: ReturnType<BbPluginApi["storage"]["database"]>;
  bb: BbPluginApi;
  /** The caller's managed row, recovering a spawn-seeded one. */
  managedRow: (threadId: string, callerProjectId: string) => Promise<ManagedRow | undefined>;
  terminal: (state: string) => boolean;
  isActiveChief: (caller: ManagedRow | undefined) => boolean;
  /** A live settings read, never the cache. */
  researchSettings: () => Promise<ResearchSettings>;
  environmentHostId: (environmentId: string) => Promise<string | null | undefined>;
  discover: <T>(run: (signal: AbortSignal) => Promise<T>, label: string) => Promise<T>;
  /** The shared start-up recipe (section, rules, model pick with cooldown check, spawn, row, brief). */
  managedSpawn: ManagedSpawn<ThreadInsert>;
  /** The machine a project's threads run on, and the host a fresh worktree is created on when Chief's own environment names none. */
  projectHost: (projectId: string) => Promise<string>;
  projectHostId: (projectId: string) => Promise<string | null | undefined>;
  /** Fast-forwards Chief's checkout before a researcher reads it; the warning line when it did not. Never throws. */
  freshenCheckout: (chief: ManagedRow) => Promise<string | null>;
  clip: (value: string, limit?: number) => string;
  maxResultLength: number;
}

/** One module owns the chief_research machinery: who may call it and the researcher thread it starts. */
export function createResearch(deps: ResearchDeps) {
  const {
    db, bb, managedRow, terminal, isActiveChief, researchSettings, environmentHostId, discover, managedSpawn,
    freshenCheckout, projectHost, projectHostId, clip, maxResultLength,
  } = deps;

  /** What a chief_research call ended as, mutated by research()'s paths and written once to chief_research_calls. */
  type ResearchCall = { role: string | null; outcome: "spawned" | "error" };

  /** Only an active registered Chief may call. Throws the reason otherwise. */
  async function researchCaller(threadId: string, projectId: string, call: ResearchCall) {
    // Unmanaged threads (helper threads included) have no row, which also stops recursion.
    const row = await managedRow(threadId, projectId);
    // The managed role is recorded as soon as it is known, so a rejected call is still attributed to it.
    if (row) call.role = row.role;
    if (!row || terminal(row.state) || row.role !== "chief") {
      throw new Error("chief_research is available only to an active Chief. A planner splits a broad scan across read-only helper threads (chief-role-read-only skill).");
    }
    if (!isActiveChief(row)) throw new Error("chief_research requires an active registered Chief thread.");
    if (!(await researchSettings()).enabled) {
      throw new Error("chief_research is off: turn on the Researcher switch in Chief's plugin settings.");
    }
    return row;
  }

  /** Why the run cannot start (the provider is not installed or at 100% of a usage window), or null. A signed-out status only warns: account-pool proxied hosts report it while pooled threads work. */
  async function researchPreflight(hostId: string, providerId: string) {
    // ponytail: fails open (missing key, error, throw, timeout) because not every provider reports usage.
    const res = await discover(async (signal) => bb.sdk.system.usageLimits({ hostId, providerId, signal }), "Usage check").catch(() => null);
    const usage = (res as Record<string, any> | null)?.[providerId];
    if (usage?.status === "not_installed") return `${providerId} is ${usage.status}`;
    if (usage?.status === "unauthenticated" || usage?.status === "expired") bb.log.warn(`Researcher provider ${providerId} reports ${usage.status}; starting anyway (a pooled or proxied host can still serve it).`);
    const full = usage?.status === "ok" ? usage.windows?.find((w: { usedPercent: number }) => w.usedPercent >= 100) : null;
    return full ? `${providerId} is out of quota (${full.label} window at ${full.usedPercent}%${full.resetsAt ? `, resets ${full.resetsAt}` : ""})` : null;
  }

  async function research(params: ResearchParams, context: { threadId: string; projectId: string }) {
    const startedAt = Date.now();
    // Every exit, caller check and settings read included, thrown or returned, leaves exactly one chief_research_calls row.
    const call: ResearchCall = { role: null, outcome: "error" };
    try {
      const chief = await researchCaller(context.threadId, context.projectId, call);
      const started = await startResearcher(params, chief);
      call.outcome = "spawned";
      return `Started researcher thread ${started.threadId} (${started.title}). It answers in ${params.branch ? `a fresh worktree on branch ${params.branch}` : "your checkout"} and reports through chief_report; the report arrives as a lifecycle alert. Do not poll: end your turn.${params.design ? " It holds the design discussion with the user in its own thread; its alert tells you when it waits on the user." : ""}${started.warning ? `\n${started.warning}` : ""}`;
    } finally {
      try {
        db.prepare(`INSERT INTO chief_research_calls (caller_thread_id, role, mode, run_id, outcome, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(context.threadId, call.role, null, null, call.outcome, startedAt, Date.now());
      } catch (error) {
        bb.log.warn(`Could not record chief_research call: ${String(error)}`);
      }
    }
  }

  /**
   * Chief's chief_research: the researcher runs in a thread on Chief's own checkout. Everything that can
   * be refused (cooldown, quota, no shareable checkout) is refused here, before a thread exists.
   */
  async function startResearcher(params: ResearchParams, chief: ManagedRow) {
    const live = await bb.sdk.threads.get({ threadId: chief.thread_id }).catch(() => null);
    const environmentId = live?.environmentId ?? null;
    const permissionMode = (await bb.sdk.threads.defaultExecutionOptions({ threadId: chief.thread_id }).catch(() => null))?.permissionMode ?? null;
    const hostId = (environmentId ? await environmentHostId(environmentId) : null) ?? (await projectHostId(chief.project_id)) ?? null;
    // The shared role path: the researcher pick if usable, else BB's default; throws while the target cools down.
    const managed = await managedSpawn.prepare(chief.project_id, { role: "researcher", hostId });
    const { providerId } = managed.execution;
    const blocked = hostId && providerId ? await researchPreflight(hostId, providerId) : null;
    if (blocked) throw new Error(`chief_research did not start: ${blocked}. Pick another researcher model in Chief settings or retry after the reset.`);
    const { branch } = params;
    // The researcher reads Chief's working tree, so it must reuse Chief's environment: no fresh worktree fallback.
    // With a branch it reads its own worktree on that branch instead.
    if (!branch && !environmentId) {
      throw new Error("chief_research did not start: Chief's checkout cannot be shared with a researcher thread (this thread has no reusable environment).");
    }
    const title = `${params.design ? "Design" : "Research"} · ${clip(params.question, 60)}`;
    const prompt = researcherBrief({ chiefThreadId: chief.thread_id, question: params.question, design: params.design, execution: managed.execution, permissionMode, maxResultLength });
    // After every refusal above: a refused call leaves Chief's checkout as it was.
    const warning = branch ? undefined : await freshenCheckout(chief);
    const thread = await managedSpawn.launch(managed, {
      projectId: chief.project_id,
      environment: branch
        ? worktreeEnvironment(hostId ?? await projectHost(chief.project_id), branch)
        : { type: "reuse", environmentId: environmentId! },
      title, prompt,
      extra: permissionMode ? { permissionMode } : {},
      onSpawnError: (error) => new Error(branch
        ? `chief_research did not start: BB could not run a researcher thread in a fresh worktree on branch ${branch} (${clip(error instanceof Error ? error.message : String(error), 200)}).`
        : `chief_research did not start: BB could not run a researcher thread in Chief's checkout (${clip(error instanceof Error ? error.message : String(error), 200)}). Nothing was started in a fresh worktree.`),
    }, { role: "researcher", chiefThreadId: chief.thread_id, brief: prompt, researchDesign: params.design, ...(branch ? { branch } : {}) });
    return { threadId: thread.id, title, warning };
  }

  return { research };
}
