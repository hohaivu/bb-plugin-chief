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
  question: z.string().trim().min(1).max(4_000).describe("The question or goal to research."),
  branch: z.string().trim().min(1).max(300).optional().describe("Run the researcher in a fresh worktree on this branch instead of your checkout."),
});
type ResearchParams = z.infer<typeof researchParams>;

/** The one chief_research instruction line: Chief's, while the switch is on. */
export function researchLine(role: string, settings: ResearchSettings | null) {
  return role === "chief" && settings?.enabled ? "Use chief_research for read-only research by a researcher thread." : null;
}

/** A researcher's prompt: the question, and how it decides between working alone and splitting across helper threads. */
export function researcherBrief(input: {
  chiefThreadId: string; question: string; execution: Partial<ModelSelection>; permissionMode?: string | null; maxResultLength: number;
}) {
  const { chiefThreadId, question, execution, permissionMode, maxResultLength } = input;
  const pinned = execution.providerId && execution.model;
  const spawn = [
    `bb thread spawn --project "$BB_PROJECT_ID" --parent-self --lifecycle-owner-thread "$BB_THREAD_ID" --environment "$BB_ENVIRONMENT_ID"`,
    ...(pinned ? [`--provider ${execution.providerId} --model ${execution.model}${execution.reasoningLevel ? ` --reasoning-level ${execution.reasoningLevel}` : ""}`] : []),
    ...(permissionMode ? [`--permission-mode ${permissionMode}`] : []),
    `--title "Research helper: <part>" --prompt-file - --json <<'EOF' … EOF`,
  ].join(" ");
  return [
    `You are the managed researcher for Chief thread ${chiefThreadId}. Report to that Chief.`,
    "", "## Question", question,
    "", "## Working contract",
    `- ${RESEARCH_ONLY}`,
    `- Decide how to work. Answer alone when the question is narrow: a few files, one hypothesis or a quick check. Split it when it has independent parts (many similar files or call sites, several hypotheses, separate sub-questions). Then spawn at most ${RESEARCH_MAX_HELPERS} helper threads, one part each, and work on the rest yourself while they run.`,
    `- Spawn a helper with: ${spawn}`,
    ...(pinned ? [] : ["- Helpers run on BB's default model for this project, as you do: pass no --provider or --model."]),
    "- The helper id is `.id` of the output.",
    `- Each helper prompt must contain: the read-only rule (${READ_ONLY}; run no command that changes tracked files or git state; you share the caller's checkout), its sub-question and the overall goal, \`Evidence is file:line or command output; mark each answer confirmed or unconfirmed\`, \`Do not spawn threads. Your final message is your answer.\``,
    "- Wait for each helper with `bb thread wait <id> --status idle --timeout 540s` as a foreground call (tool timeout 570000 ms). Read its answer with `bb thread output <id>`. A helper that failed or is still not idle after a second wait: `bb thread stop <id>`, and list it as a failure. Never poll with sleep loops.",
    "- While a helper runs, run no git command that changes this checkout (fetch, checkout, reset).",
    "- Check every answer you rely on against the code, and drop or mark unconfirmed any answer whose evidence does not hold. Write ## Confirmed (each with its evidence) and ## Unconfirmed sections. Name each failed or stopped helper, and say the result is partial when any part has no answer.",
    "- Before you report, stop any helper still running.",
    `- Report with chief_report state ready: \`result\` is the full report within ${maxResultLength} characters, \`summary\` at most 800 characters, and the first line of result says \`Helpers: <n>\` (0 when you worked alone). When nothing usable came back, report blocked with the cause as blocker and your recommended next step as recommendation.`,
    "- Do not ask the user directly from this thread.",
  ].join("\n");
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
      return `Started researcher thread ${started.threadId} (${started.title}). It answers in ${params.branch ? `a fresh worktree on branch ${params.branch}` : "your checkout"} and reports through chief_report; the report arrives as a lifecycle alert. Do not poll: end your turn.${started.warning ? `\n${started.warning}` : ""}`;
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
    const title = `Research · ${clip(params.question, 60)}`;
    const prompt = researcherBrief({ chiefThreadId: chief.thread_id, question: params.question, execution: managed.execution, permissionMode, maxResultLength });
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
    }, { role: "researcher", chiefThreadId: chief.thread_id, brief: prompt, ...(branch ? { branch } : {}) });
    return { threadId: thread.id, title, warning };
  }

  return { research };
}
