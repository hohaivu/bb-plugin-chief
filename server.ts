import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { forgeInitScript } from "./forge";
import { classify, composeComment, errorText, hasMarker, ownerHandle, parseForgeTarget, postComment, sanitizeForge, withMention } from "./forgeComments";
import { CONSULT_AFTER_REJECTIONS, STOP_AFTER_REJECTIONS, createReviewLedger, type ReviewTarget } from "./reviewLedger";
import { createManagedSpawn } from "./managedSpawn";
import { computeImpactSlice, gitWithin, reviewedAncestry, type ImpactSlice } from "./impactSlice";
import { cleanupEligible, deleteSafeBranch, ownedBranch } from "./cleanup";
import { createReviewStart, type PinnedHead } from "./reviewStart";
import { createThreadStore, type ThreadInsert } from "./threadStore";
import {
  LESSON_MAX, MAX_FINDINGS, MAX_PLAN_LENGTH, MAX_REPORT_FAILS, MAX_WAVES, REPORT_TEXT_MAX, SUMMARY_MAX,
  checkReport, contractsOf, findingLines, reportAlert, reportFileBody, verdictFileBody, type Pointer,
} from "./reportIntake";
import { advisorBrief, plannerBrief, resolveDelegation, verdictPreview, workerBrief } from "./delegationBrief";
import { clip, clipMiddle, recordedLines, type RecordedCommand } from "./text";
import { createPlanProgress, type SegmentState } from "./planProgress";
import { chainOf, createWaveSchedule, parentOf, successorOf, waveTitle } from "./waveSchedule";
import {
  ADVISE_ONLY, CONTINUE_REMINDERS, MODEL_FALLBACK, PLAN_ONLY,
  managedSkills, modelRoleSchema, roleSchema, workerKindSchema,
  type ModelRole, type Role,
} from "./roles";
import {
  RESEARCH_DEFAULT_TIMEOUT_MINUTES, agentCapSchema, createResearch, modelSelectionSchema, researchConfigurationSchema, researchLine,
  researchModeSchema, researchParams, researchSettingsPatchSchema, researchSettingsSchema, timeoutSchema,
  type ModelSelection, type ResearchMode, type ResearchSettings,
} from "./research";

export { RESEARCH_SCRIPTS } from "./research";
export type { ModelSelection, ResearchConfiguration } from "./research";

const SECTION_NAME = "Chief";
const RULES_FILE = "chief.md";
const RECONCILE_INTERVAL_MS = 30_000;
const MAX_RESULT_LENGTH = 8_000;
// ponytail: a nudge is 1–3 sentences; anything longer is new work for a fresh thread.
const MAX_NUDGE_LENGTH = 500;
const REVIEW_IDLE_WAIT_MS = 60_000;
const REVIEW_IDLE_POLL_MS = 2_000;
// ponytail: done capped at 50, newest first
const MAX_DONE_ITEMS = 50;
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
/** chief_continue calls per stall episode that re-arm the stall clock; later ones still deliver the nudge but leave the alert schedule alone. A report resets the count. */
const MAX_STALL_RESETS = 2;
const FORGE_CLI_TIMEOUT_MS = 10_000;
/** Longest mission, success criteria or constraints text chief_forge_init puts in a pull request body. */
const FORGE_BRIEF_SECTION_MAX = 1_500;
const BUSY_STATUSES = new Set(["active", "starting", "stopping", "pending"]);

const execFileAsync = promisify(execFile);

/** Races one call against a deadline. A synchronous throw becomes a rejection, and the timer never outlives the call.
 * A call that loses the race is abandoned, not cancelled. */
async function bounded<T>(call: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => call())(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline passed")), Math.max(ms, 0)); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Homebrew bins appended to the server's PATH.
 * ponytail: heuristic for GUI-launched servers whose PATH lacks Homebrew; upgrade path is a configured PATH. */
function serverPath() {
  return `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin`;
}
/** The environment every forge CLI call runs with: the server's PATH plus Homebrew, so a GUI-launched server still finds gh and glab. */
const forgeEnv = () => ({ ...process.env, PATH: serverPath() });
const FORGE_SCRIPT_TIMEOUT_MS = 120_000;

type Forge = "github" | "gitlab";

/** Pulls the forge target (and, when the reference names its own repo, the repo
 * to pass alongside it) out of a PR number, an owner/repo#123 reference, or a
 * PR/MR URL. An explicit URL also names its forge, so callers don't need to
 * re-derive it from a repo checkout that may not even be the right one. */
function parsePullRequestRef(input: string): { target: string; repo: string | null; forge: Forge | null } {
  const githubUrl = input.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (githubUrl) return { target: githubUrl[3], repo: `${githubUrl[1]}/${githubUrl[2]}`, forge: "github" };
  const gitlabUrl = input.match(/\/([^/\s]+)\/([^/\s]+)\/-\/merge_requests\/(\d+)/);
  if (gitlabUrl) return { target: gitlabUrl[3], repo: `${gitlabUrl[1]}/${gitlabUrl[2]}`, forge: "gitlab" };
  const shortRef = input.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (shortRef) return { target: shortRef[2], repo: shortRef[1], forge: null };
  return { target: input.replace(/^#/, ""), repo: null, forge: null };
}

/** Best-effort: resolves a pull request reference to its head branch with
 * whichever forge CLI the repo uses, mirroring the detection in forgeInitScript.
 * An explicit URL's own forge wins; a bare number or owner/repo#123 reference
 * falls back to `git remote get-url origin` in the target project's own
 * checkout (cwd), never this process's own. Every subprocess is time-bounded,
 * and any failure — no remote, no CLI, no auth, an unrecognised reference, a
 * hung subprocess — returns null so the caller falls back to treating the
 * input as a plain branch name. */
async function resolvePullRequestBranch(pullRequest: string, cwd: string | null): Promise<string | null> {
  return (await prHead(pullRequest, cwd))?.branch ?? null;
}

/** The forge targets a pull request reference could live on, with its number and repo. */
async function pullRequestForges(pullRequest: string, cwd: string | null) {
  const { target, repo, forge } = parsePullRequestRef(pullRequest);
  let forges: Forge[] = forge ? [forge] : [];
  if (!forges.length) {
    const remote = cwd
      ? await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() })
          .then((result) => result.stdout.trim())
          .catch(() => "")
      : "";
    // A self-hosted forge under another name could be either; ask gh, then glab.
    forges = remote.includes("github") ? ["github"] : remote.includes("gitlab") ? ["gitlab"] : ["github", "gitlab"];
  }
  return { target, repo, forges };
}

/** Best-effort live head of a pull request: its branch, the commit the forge says
 * the branch is at right now, and the branch it targets. Any failure returns null
 * (callers either fall back or fail closed, as their contract says). */
async function prHead(pullRequest: string, cwd: string | null): Promise<{ branch: string; sha: string; base: string } | null> {
  try {
    const { target, repo, forges } = await pullRequestForges(pullRequest, cwd);
    for (const candidate of forges) {
      const head = await (candidate === "github" ? githubHead : gitlabHead)(target, repo, cwd).catch(() => null);
      if (head) return head;
    }
    return null;
  } catch {
    return null;
  }
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

async function githubHead(target: string, repo: string | null, cwd: string | null) {
  const args = ["pr", "view", target, "--json", "headRefName,headRefOid,baseRefName", ...(repo ? ["--repo", repo] : [])];
  const { stdout } = await execFileAsync("gh", args, { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() });
  const parsed = JSON.parse(stdout) as { headRefName?: string; headRefOid?: string; baseRefName?: string };
  return headOf(parsed.headRefName, parsed.headRefOid, parsed.baseRefName);
}

async function gitlabHead(target: string, repo: string | null, cwd: string | null) {
  const args = ["mr", "view", target, "-F", "json", ...(repo ? ["--repo", repo] : [])];
  const { stdout } = await execFileAsync("glab", args, { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() });
  const parsed = JSON.parse(stdout) as { source_branch?: string; sha?: string; diff_refs?: { head_sha?: string }; target_branch?: string };
  return headOf(parsed.source_branch, parsed.sha ?? parsed.diff_refs?.head_sha, parsed.target_branch);
}

function headOf(branch?: string, sha?: string, base?: string) {
  const head = { branch: branch?.trim() ?? "", sha: sha?.trim().toLowerCase() ?? "", base: base?.trim() ?? "" };
  return head.branch && head.base && SHA_PATTERN.test(head.sha) ? head : null;
}

/** Best-effort: flips a draft pull request to ready for review with whichever forge
 * CLI hosts it. Never throws: the result says whether it worked, with the error text when not. */
async function markPrReady(pullRequest: string, cwd: string | null): Promise<{ ready: boolean; error?: string }> {
  let error = "no forge CLI could mark it ready";
  try {
    const { target, repo, forges } = await pullRequestForges(pullRequest, cwd);
    for (const candidate of forges) {
      const [cli, args] = candidate === "github"
        ? ["gh", ["pr", "ready", target, ...(repo ? ["--repo", repo] : [])]]
        : ["glab", ["mr", "update", target, "--ready", "--yes", ...(repo ? ["--repo", repo] : [])]];
      try {
        await execFileAsync(cli as string, args as string[], { cwd: cwd ?? undefined, timeout: FORGE_CLI_TIMEOUT_MS, env: forgeEnv() });
        return { ready: true };
      } catch (failure) {
        error = clip(String((failure as { stderr?: unknown }).stderr || failure).trim(), 200);
      }
    }
  } catch (failure) {
    error = clip(String(failure), 200);
  }
  return { ready: false, error };
}

/** What a spawn seeds into a thread's pluginMetadata, read back in bb.agents.configure.
 * insertThread runs only after threads.spawn resolves, so the very first configure()
 * call for a brand-new thread can land before that row exists; pluginMetadata is
 * seeded atomically at spawn time and survives that gap. Untrusted input, so parsed
 * defensively like everything else crossing this boundary. */
const spawnMetadataSchema = z.object({
  role: roleSchema,
  chiefThreadId: z.string().nullable().optional(),
  kind: workerKindSchema.optional(),
  planThreadId: z.string().optional(),
});
/** A reviewer's structured judgement. Chief routes on this field instead of
 * parsing a ship-or-fix opinion out of the report prose. */
const verdictSchema = z.enum(["approve", "request_changes"]);
const stateSchema = z.enum([
  "starting",
  "pending",
  "active",
  "stopping",
  "idle",
  "ready",
  "blocked",
  "failed",
  "archived",
  "deleted",
  "complete",
]);

const modelConfigurationSchema = z.object({
  hosts: z.array(z.object({
    hostId: z.string(),
    hostName: z.string(),
    connected: z.boolean(),
    /** A valid starting point for the picker when a role has no selection. */
    fallback: modelSelectionSchema.nullable(),
    error: z.string().nullable(),
    selections: z.object({
      chief: modelSelectionSchema.nullable(),
      planner: modelSelectionSchema.nullable(),
      worker: modelSelectionSchema.nullable(),
      designer: modelSelectionSchema.nullable(),
      reviewer: modelSelectionSchema.nullable(),
      advisor: modelSelectionSchema.nullable(),
    }),
    /** Roles whose stored pick this machine can no longer serve, so spawns use BB's default. */
    unusable: z.array(modelRoleSchema),
  })),
});
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

const todoItemSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  action: z.string().nullable(),
  done: z.boolean(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

const managedThreadSchema = z.object({
  threadId: z.string(),
  role: roleSchema,
  projectId: z.string(),
  chiefThreadId: z.string().nullable(),
  workerThreadId: z.string().nullable(),
  title: z.string(),
  state: stateSchema,
  status: z.string().nullable(),
  result: z.string().nullable(),
  blocker: z.string().nullable(),
  recommendation: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ManagedThread = z.infer<typeof managedThreadSchema>;

const delegateShape = z.object({
  title: z.string().trim().min(1).max(160).describe("Exact concise title for the worker thread."),
  mission: z.string().trim().min(1).max(12_000).describe("What to achieve, in the user's terms. State a cause only when evidence already states it (see the core rules), naming its source; never your own guess."),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional().describe("Observable outcomes: each one checked by a command with its exit status, or named for Manual Verification."),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional().describe("Limits the work must respect: scope, files or behaviour to leave alone, user rules."),
  context: z.string().trim().max(12_000).optional().describe("Supporting evidence, each item with its source (user message, issue, report, alert, reviewer verdict), plus links and prior work."),
  branch: z.string().trim().min(1).max(300).optional().describe(
    "The task branch Chief already created and pushed. The worktree is based on it and the worker commits there. Omit to base the worktree on the project default.",
  ),
  issueUrl: z.string().trim().min(1).max(500).optional().describe("URL of the tracking issue Chief opened for this task, when the forge has issues."),
  prUrl: z.string().trim().min(1).max(500).optional().describe("URL of the draft pull request Chief opened from the task branch. The worker never marks it ready."),
  replaces: z.string().trim().min(1).optional().describe("A finished worker's thread id to hand off from: the new worker starts in that worker's worktree and branch, gets its latest review findings and the path to the reviewer's full verdict file, and the old worker is marked complete."),
  planThreadId: z.string().trim().min(1).optional().describe("A planner thread that reported a wave schedule. Combined with wave, the plugin takes the plan file from that schedule."),
  wave: z.number().int().min(1).max(MAX_WAVES).optional().describe("1-based index into planThreadId's wave schedule."),
  unplannedReason: z.string().trim().min(1).max(300).optional().describe("Required when planning is on and this work skips chief_plan: your reason for skipping the plan (your judgment; see the core rules). Not needed with planThreadId/wave or replaces."),
  kind: workerKindSchema.optional().describe("designer when the agent decides or implements how the UI looks: drawing or editing in a design tool (Paper, Figma, …), implementing a design-tool artboard in code (design-to-code), or building UI with no approved design or explicit visual spec. worker (the default) only when an approved design or an explicit spec in the request, an issue, or a report already fixes the look. A replaces: successor keeps the prior worker's kind. Exception: a plan's design-only wave (design: true) defaults to designer and only draws; the wave that implements its approved artboards is a worker. tester writes and runs tests, nothing else: a plan's test wave (test: true) defaults to tester on its first hand-off; on unplanned work it needs replaces:. Replacing a tester, or a worker on a test wave, needs an explicit kind: worker to change product code, tester to change tests."),
  userApprovedRound: z.boolean().optional().describe(`Set only with replaces: and only after the user explicitly approved another review round in this thread: a replaced worker whose reviewer has requested changes ${STOP_AFTER_REJECTIONS} times in a row is refused without it.`),
  verifyCommand: z.string().trim().min(1).max(500).optional().describe("One shell command the worker's brief tells it to run after its last commit and get exit 0 from before reporting ready: a build/lint check for a worker, e.g. `npx tsc --noEmit && bb plugin build`; a tester's may be a filtered test command. Nothing reruns it: reviewers read code only. Inherited through replaces:."),
});

const delegateParams = delegateShape.superRefine((value, ctx) => {
  if (value.unplannedReason && value.planThreadId) {
    ctx.addIssue({ code: "custom", path: ["unplannedReason"], message: "unplannedReason cannot be combined with planThreadId." });
  }
});

/** A planner is briefed on the same problem as a worker, minus the criteria and
 * constraints it is being asked to propose. */
const planParams = delegateShape.pick({ title: true, mission: true, context: true }).extend({
  revises: z.string().trim().min(1).optional().describe("A planner whose plan its one advisor review sent back with changes: the new planner revises that plan with the advice attached, and its plan is delegated with no second review."),
});

interface ChiefHandoff { fromChiefThreadId: string; title: string; request: string; context: string }

// Oversize input is refused, never clipped. With a todo attached, `\n\nTodo #<id>: <text>` (text <= 500) is
// appended to context, so the handoff's context is at most 12_000 + that prefix + 500 characters.
const spawnParams = z.object({
  title: z.string().trim().min(1).max(160).describe("A literal task label, used in the new Chief's thread title."),
  request: z.string().trim().min(1).max(4_000).describe("The owner's words asking for this task, verbatim."),
  context: z.string().trim().min(1).max(12_000).describe("Goal and success criteria, evidence, linked threads/issues/PRs/branches, plan and verdict file paths, and open decisions."),
  todoId: z.number().int().optional().describe("Your own open todo to move to the new Chief."),
});

const consultParams = delegateShape.pick({ title: true, mission: true, context: true }).extend({
  workerThreadId: z.string().trim().min(1).optional().describe("The managed worker whose change keeps failing review: the advisor runs in its worktree and gets its brief, reviewer verdicts, and branch."),
  planThreadId: z.string().trim().min(1).optional().describe("A planner whose multi-wave or complex plan needs its one read-only advisor review before chief_forge_init or chief_delegate. Not with workerThreadId."),
});

const reviewParams = z.object({
  workerThreadId: z.string().trim().min(1).optional().describe("An existing managed worker's thread id."),
  pullRequest: z.string().trim().min(1).max(500).optional().describe(
    "A pull request to review when no managed worker owns it: a number, an owner/repo#123 reference, or a PR URL. Resolved to its head branch with gh or glab, falling back to the raw value as a branch name.",
  ),
  branch: z.string().trim().min(1).max(300).optional().describe("A branch to review when no managed worker owns it."),
  focus: z.string().trim().max(4_000).optional(),
}).refine((value) => [value.workerThreadId, value.pullRequest, value.branch].filter((v) => v !== undefined).length === 1, {
  message: "Give exactly one of workerThreadId, pullRequest, or branch.",
});

/** Why a worker is completed without a matching approve; recorded in its result. */
const overrideSchema = z.string().trim().min(1).max(500).optional();

const stopParams = z.object({
  threadId: z.string().trim().min(1),
  reason: z.string().trim().max(1_000).optional().describe("Why it is being stopped: what the evidence shows it stuck on."),
});

const failEntry = z.object({
  text: z.string().trim().min(1).max(400),
  scope: z.string().trim().min(1).max(120),
  basis: z.string().trim().min(1).max(200).describe("the command, test or input that reproduces it"),
});
type FailEntry = z.infer<typeof failEntry>;
const MAX_CARRIED_FAILS = 12;
/** chief_report's fails entry. Published without length limits: checkReport enforces them in one pass, with a fix per field. */
const reportFailEntry = z.object({
  text: z.string().trim().describe("at most 400 characters"),
  scope: z.string().trim().describe("at most 120 characters"),
  basis: z.string().trim().describe("at most 200 characters: the command, test or input that reproduces it"),
});
// A string is a JSON-encoded array some callers send; report() decodes it and checkReport refuses anything else.
const failsParam = z.union([z.string().trim(), z.array(reportFailEntry)]).optional().describe(
  `Worker or reviewer only: approaches tried and ruled out, so a replacement worker does not retry them. At most ${MAX_REPORT_FAILS} per report.`,
);
/** A reviewer's structured finding, published without limits; checkReport enforces them. */
const reportFinding = z.object({
  file: z.string().trim().describe("1-300 characters"),
  line: z.number().int().optional().describe("1-based line"),
  severity: z.enum(["blocking", "nit"]),
  message: z.string().trim().describe("1-1000 characters"),
  fix: z.string().trim().optional().describe("at most 1000 characters"),
});
export type ReportFinding = z.infer<typeof reportFinding>;
const findingsParam = z.union([z.string().trim(), z.array(reportFinding)]).optional().describe(
  `Ready only, reviewer only. Required on a reviewer's ready report ([] allowed for an approve with nothing to note). One entry per finding, at most ${MAX_FINDINGS}. request_changes iff at least one blocking. \`[AMBIGUOUS: …]\` items stay in result, not here.`,
);
const MAX_LOG_READ = 30;
const logParams = z.object({
  entries: z.array(failEntry.extend({ kind: z.enum(["FACT", "FAIL"]) })).max(5).optional().describe(
    "Notes for peer waves: FACT for a finding that could change their next step, FAIL for a dead end. Omit to only read.",
  ),
});
/** One wave of a planner's plan array, published without limits; checkReport enforces them. */
const waveShape = z.object({
  body: z.string().trim(),
  dependsOn: z.array(z.number().int()).optional().describe(
    "1-based index of the earlier wave this one builds on, at most one. [] = independent: it starts its own branch and pull request on the default base. [k] = builds on wave k and continues on its branch. Omitted = depends on the previous wave (wave 1: none).",
  ),
  design: z.boolean().optional().describe(
    "true only for a design-only wave: a Designer draws the artboards in a design tool and writes no app code; the wave that builds on it implements them as a worker after the owner approves the artboards. Never on a chain tip.",
  ),
  test: z.boolean().optional().describe(
    "true for a test wave: a tester writes and runs the tests for its parent wave on that wave's branch. Every chain ends with one; its parent is an implementation wave (neither design nor test).",
  ),
});
// One flat object, published without length limits: the validator's own errors cannot be customised, so checkReport()
// in report() enforces every limit and per-state rule and names all failing fields in one error.
const reportParams = z.object({
  state: z.enum(["active", "idle", "failed", "ready", "blocked"]),
  result: z.string().trim().optional().describe(
    "The full report, any length; the plugin saves it to a per-report file. Required and non-empty when state is ready.",
  ),
  summary: z.string().trim().optional().describe(
    `Short summary Chief reads in the alert, at most ${SUMMARY_MAX} characters: outcome, changed files or verdict, verification commands with exit status, and next action. Put the full report in \`result\`; the plugin saves it to a file Chief can open. Leave this unset when \`result\` is already this short.`,
  ),
  verdict: verdictSchema.optional().describe(
    "Ready only. Required in a review thread: approve when the change can ship as it stands, request_changes only when at least one blocking finding exists; nits alone never reject. Workers leave this unset.",
  ),
  lesson: z.string().trim().optional().describe(
    `Ready only, advisor or reviewer, at most ${LESSON_MAX} characters. An advisor records one durable, project-level rule future workers should follow so this class of rejection does not recur; a reviewer records a durable review rule or known false positive, shown to future reviewers only. Omit when the cause is task-specific.`,
  ),
  regression: z.boolean().optional().describe(
    "Ready only, reviewer only, with request_changes: true when the change introduced a new problem or regression that was not there before. Workers leave this unset.",
  ),
  complex: z.boolean().optional().describe(
    "Planner ready report only: true when the plan is high-risk (see your brief). A multi-wave plan gets one advisor review either way.",
  ),
  plan: z.union([
    z.string().trim(),
    z.array(waveShape),
  ]).optional().describe(
    `Ready only. A planner's ready report requires this: an array of 2 to ${MAX_WAVES} {body, dependsOn?, design?, test?} (1-based) waves, each body at most ${MAX_PLAN_LENGTH.toLocaleString("en-US")} characters. dependsOn has at most one entry: the 1-based earlier wave this one builds on; [] = independent, omitted = depends on the previous wave. design: true marks a design-only wave; test: true marks a test wave, and every chain ends with one. Chief receives each wave as its own file, not inline. No other role sets this.`,
  ),
  blocker: z.string().trim().optional().describe(`Required when state is blocked, at most ${REPORT_TEXT_MAX.toLocaleString("en-US")} characters; leave unset otherwise.`),
  recommendation: z.string().trim().optional().describe(`Required when state is blocked, at most ${REPORT_TEXT_MAX.toLocaleString("en-US")} characters: your recommended decision or next action.`),
  fails: failsParam,
  findings: findingsParam,
});

export type ReportParams = z.infer<typeof reportParams>;

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ sectionId: z.string().nullable(), threads: z.array(managedThreadSchema) }),
  },
  start: {
    input: z.object({ projectId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }).strict(),
  },
  create: {
    input: z.object({ projectId: z.string().trim().min(1) }).strict(),
    output: z.object({ threadId: z.string(), created: z.literal(true) }).strict(),
  },
  modelConfiguration: {
    input: z.null(),
    output: modelConfigurationSchema,
  },
  researchConfiguration: {
    input: z.null(),
    output: researchConfigurationSchema,
  },
  setResearchModel: {
    input: z.object({
      hostId: z.string().trim().min(1),
      mode: researchModeSchema,
      selection: modelSelectionSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  setResearchSettings: {
    input: researchSettingsPatchSchema,
    output: researchSettingsSchema,
  },
  setRoleModel: {
    input: z.object({
      hostId: z.string().trim().min(1),
      role: modelRoleSchema,
      selection: modelSelectionSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  role: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ role: roleSchema.nullable() }).strict(),
  },
  pending: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ chief: z.boolean(), items: z.array(todoItemSchema), doneOmitted: z.number() }).strict(),
  },
});

interface TodoRow {
  id: number;
  project_id: string;
  text: string;
  after: string | null;
  state: "open" | "done" | "dropped";
  chief_thread_id: string | null;
  updated_at: number;
}

export interface ManagedRow {
  thread_id: string;
  role: Role;
  branch: string | null;
  issue_url: string | null;
  /** Planner row only: the one tracking issue every wave of its plan shares, once chief_forge_init has made it. */
  plan_issue_url: string | null;
  pr_url: string | null;
  project_id: string;
  chief_thread_id: string | null;
  worker_thread_id: string | null;
  parent_thread_id?: string | null;
  title: string;
  state: z.infer<typeof stateSchema>;
  status: string | null;
  result: string | null;
  blocker: string | null;
  recommendation: string | null;
  verdict: z.infer<typeof verdictSchema> | null;
  /** Reviewer row only: the last request_changes verdict's regression flag, persisted so
   * nextAction (a pure function of ManagedRow) can see it on a later call, not just the
   * report() turn that set it. */
  regression: number | null;
  brief: string | null;
  active_since: number | null;
  active_cycle: number;
  reject_streak: number;
  stall_alerted_cycle: number | null;
  stop_alerted_cycle: number | null;
  /** chief_continue calls since the last report that re-armed the stall clock, capped at MAX_STALL_RESETS. */
  stall_resets: number;
  lifecycle_alert_key: string | null;
  /** Planner row only: JSON `[{path}]`, the schedule a planner-ready report persisted. */
  plan_waves: string | null;
  /** Planner row only: NULL (no review needed), 'required', or the one review's outcome 'approved' or 'changes'. */
  plan_review: string | null;
  /** Advisor row only: when it first reported ready or blocked, or null. */
  advised_at: number | null;
  /** Worker row: the planner it was delegated from, with plan_wave, when planThreadId/wave was given. Advisor row: the planner whose plan it reviews. */
  plan_thread_id: string | null;
  plan_wave: number | null;
  /** Worker row only: the reason it was delegated without a plan while planning was on. */
  unplanned_reason: string | null;
  /** Incremented on every chief_report call from this row, regardless of role. */
  report_seq: number;
  /** Reviewer row only: the worker's report_seq this reviewer was started for —
   * the tie nextAction uses to know whether it already covers the worker's latest
   * report, instead of comparing updated_at timestamps. */
  reviewed_report_seq: number | null;
  /** Reviewer row only: the PR head commit the forge reported when this reviewer was spawned, or null (no PR, or head unreadable). */
  reviewed_head_sha: string | null;
  /** Worker row: the worker it replaced through replaces:. Planner row: the planner whose plan it revises. Otherwise null. */
  replaces_thread_id: string | null;
  /** Design-wave worker only: the owner's approval of its artboards, in the owner's words as Chief quoted them; null until recorded, and cleared by the worker's next report or chief_continue. */
  owner_approval: string | null;
  owner_approved_at: number | null;
  /** The state of the row's latest chief_report, or null (none sent). */
  last_report_state: string | null;
  /** Reviewer row only: the verdict-<seq>.md its last ready report was written to, or null. */
  verdict_path: string | null;
  /** The last chief_report's short summary, or null (none sent, or chief_complete replaced the result). */
  summary: string | null;
  /** The report-<seq>.md holding that report in full, or null (short report, reviewer verdict, or write failed). */
  report_path: string | null;
  /** Incremented when chief_complete replaces the result; guards the report_path publication in report(). */
  result_rev: number;
  /** Worker row only: "designer" for design-tool work, "tester" for test work; null (pre-migration or plain) means worker. */
  kind: "designer" | "tester" | null;
  /** legacy: workers delegated on the retired simple tag; read only by bb chief stats */
  simple: number | null;
  /** Worker row only: Chief's reason for completing it with skipReview, without a review; null otherwise. */
  review_skipped: string | null;
  /** Worker row only: Chief's reason for completing unplanned work with no tester (chief_complete testsSkipped); null otherwise. */
  tests_skipped: string | null;
  /** Worker row only: the command the worker's brief makes it run; nothing reruns it. */
  verify_command: string | null;
  /** Worker row only: 1/0 for planning on/off at delegation; null for rows from before the column. */
  planner_on: number | null;
  /** Worker or reviewer row: JSON FailEntry[] (oldest first, at most 12) its reports ruled out, or null. */
  fails: string | null;
  findings: string | null;
  /** Worker row on a plan: the highest plan_log id chief_log has shown it, or null. */
  log_read_id: number | null;
  /** Non-transient failed events counted for bb chief stats (since stats_since). */
  thread_errors: number;
  /** Busy-worker refusals of consult, replaces or review, counted for bb chief stats (since stats_since). */
  busy_rejections: number;
  /** Worker row only: when chief_complete stamped it as positively approved while cleanupApproved was on; NULL otherwise, and on every row from before the column. */
  cleanup_approved_at: number | null;
  created_at: number;
  updated_at: number;
}

/** One worker a reviewer covers: the report and PR head its verdict is bound to. */
interface AlertRow {
  dedupe_key: string;
  target_thread_id: string;
  source_thread_id: string;
  message: string;
  delivered_at: number | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
}

const BUILT_IN_RULES = `# Chief operating rules

- Own work through completion; do not merely dispatch it.
- Inspect the worker's evidence before choosing the next action.
- Take safe, reversible next steps autonomously: continue a thread or mark verified work complete.
- Escalate to the user only for genuine product or scope choices, missing permission or credentials, irreversible actions, or conflicting evidence that cannot be resolved safely.
- When escalating, lead with a recommendation, the evidence, and the smallest set of choices.
- Keep thread titles literal and recognizable. Never invent codenames.
- Do not delete user threads. Mark managed work complete.`;

/** Sent to Chief on every turn after the project's rules (chief.md or BUILT_IN_RULES), so an override cannot drop them. The single statement of each rule; other prompts point here. */
const CHIEF_CORE_RULES = `# Chief core rules (always apply)

- Evidence: Chief never edits code and never runs anything in a worktree: every change, commit and push is a worker's. It may read a few project files to decide how to route work (plan or not, review or not). Its evidence is worker and reviewer reports, lifecycle alerts, the recorded commands in ready alerts, chief_inspect output, and reviewer verdicts. A cause no evidence states, doubtful evidence, or a disputed factual claim goes to a child thread (chief_plan when offered, chief_review, or chief_research when offered), never to Chief reading code; so does a broad scan or an unclear cause.
- Fresh worker: a worker that has reported is never reused. Follow-up work (skipped acceptance criteria, a review's requested changes, the next wave, a rebase or restack, a push or a failed push, discarding changes, or any new task) goes to a fresh worker, and writing or running tests to a fresh tester, with chief_delegate replaces: (same worktree, branch, and pull request). After replaces:, review and complete the successor, not the superseded worker. chief_continue only nudges a thread that is still working.
- Review: only you start reviews, with chief_review; the server refuses every other caller. Start one independent review when a worker's ready alert says to: for a worker with no plan link, its own; for a plan, one review of every branch after every wave is ready, never between waves. Complete the work on that reviewer's approve (or skip the review, see Skips): chief_complete refuses a worker without skipReview unless its newest review approves the pull request's current head commit, and it marks the worker's pull request ready itself, so never run gh pr ready or glab mr update --ready for a worker's pull request. A pull request or branch no worker owns (a branch review) is the exception: its review runs in a fresh worktree, and you mark the pull request ready yourself, only on that reviewer's approve. Reviewers read code only; nothing runs a check before them.
- Tests: workers and designers never write or run tests; a tester (kind: tester) does. A plan's test wave runs as a tester on its parent's branch; on unplanned work delegate one with chief_delegate (replaces: the worker, kind: tester). Going without tests is your decision with a recorded reason: chief_skip_tests on a plan's test wave, testsSkipped on chief_complete for unplanned work. On a tester's branch a product fix is chief_delegate (replaces: …, kind: worker), a test fix kind: tester; after a worker's fix there, its ready alert offers a rerun.
- Skips: you decide, per task, whether to skip the planner (chief_delegate unplannedReason), the review (chief_complete skipReview) or the tests (chief_skip_tests, testsSkipped), and always state why. Guidance, not a rule: a skip suits a small, local, low-risk change whose shape is known; plan and review new features, multi-file designs, unclear causes, security or persistence changes, and anything the user asked to plan or review. Before skipping a review, read the worker's ready report and recorded commands: its lint/build and any verify command must show exit 0. You never run checks yourself. The server refuses a review skip only while a review is running, without a ready report (a waived test wave's blocked report counts), on a design wave, or together with override; a test skip only while that wave's worker is running or once it is complete.
- Need you: before writing a **Need you** request in chat, call chief_escalate with the managed thread it concerns and the full request.`;

/** Planning is on by default: the plugin persists the planner's wave schedule and
 * names the exact next call, so Chief relays it without reading the plan itself. */
const PLANNER_CHIEF_INSTRUCTIONS =
  "Planning is on. Use chief_plan first for every new feature, multi-file change, or task whose design or cause is not already settled, a well-specified issue included. Order for every delegation: chief_plan (skipped only with unplannedReason: your reason) → chief_forge_init (planThreadId and wave, so the plan travels in the pull request body) → chief_delegate. After chief_plan, its ready alert lists the wave schedule and the exact next call. When it names the waves to delegate, delegate every wave it lists right away, one chief_delegate per wave in the same turn, without user sign-off and without reading the plan file — the one exception: a design-only wave's ready alert asks you to get the owner's approval of its artboards before you delegate the next wave. Only the owner approves design-only work, never a reviewer: record their words with chief_owner_approval (chief_review refuses it), and the next wave will not delegate without it. Every plan ends each chain with a test wave (test: true) that a tester runs on its parent's branch; its parent's ready alert names the call, or chief_skip_tests to go without. A plan with more than one implementation wave (test waves do not count), or one its planner marked complex, gets exactly one read-only advisor review first: its ready alert asks for chief_consult (planThreadId), and chief_forge_init and chief_delegate refuse it until that review resolves. On approve, delegate it as it is; on request_changes or a blocked advisor, its alert asks for chief_plan (revises), and the revision is delegated with no second review. chief_delegate rejects a call without planThreadId and wave unless you pass unplannedReason (your reason; see the core rules). Escalate to the user only for a genuine product or scope open question that the planner could not resolve. A plan is never implementation: only a worker changes code.";

const DESIGN_REVIEW_REFUSAL = "Design-only work is approved by the owner only: show the user the artboards and record their decision with chief_owner_approval.";

/** Chief-only cue for when to reach for chief_research; sent while research is on. */
function researchChiefInstructions(planning: boolean) {
  return `chief_research is optional. Each call returns at once with the researcher thread's id: the fan-out runs in that child thread, and its merged result arrives as the researcher's report alert, so end your turn and wait instead of polling. Use it for a broad multi-file scan or several independent questions at once, for example scoping a large issue${planning ? " before chief_plan" : ""} or checking doubtful worker or reviewer evidence. ${planning ? "Finding a cause you cannot see in a quick read is the planner's job: send that to chief_plan. " : ""}When a report says the run failed, was partial, or timed out, do not rerun the same fan-out: send the open question to ${planning ? "chief_plan" : "chief_consult"}, or the doubtful evidence to chief_review.`;
}

/** chief_roster's Pending block is the canonical work list; keep Chief calling it
 * at each turn start and after compaction instead of relying on memory. */
const ROSTER_CHIEF_INSTRUCTIONS =
  "Call chief_roster at the start of every turn, and again after any compaction, before acting: its Pending block is the current work list. Track every todo — including work the user queued that nobody has delegated yet — with chief_roster's `todo` field; never use Memory files, TodoWrite, or Task tools for Chief work. When work a todo tracks is finished, close that todo in the same turn with chief_roster todo { id, state: \"done\" }. Each todo belongs to the Chief thread that added it. The Pending block lists other Chiefs' and unowned todos apart, tagged with their owner: know they exist, but they are not your work — do not act on, edit, or close one unless the user asks.";

/** Lifecycle alerts already wake Chief; polling managed threads only burns context. */
const WAIT_CHIEF_INSTRUCTIONS =
  "Lifecycle alerts wake you when a managed thread reports, hits a transient provider failure, or stalls; going idle, being archived or being deleted only updates the roster. After you act, end your turn and wait for the next alert: never poll managed threads with `bb thread wait`, `bb thread show`, or sleep loops. When you need a thread's state now, call chief_inspect once.";

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    const next = argv[index + 1];
    // A boolean flag never takes a value: `--json thr_x` keeps thr_x positional.
    const value = inline ?? (name !== "json" && next && !next.startsWith("--") ? (index++, next) : "true");
    flags.set(name!, [...(flags.get(name!) ?? []), value]);
  }
  return {
    positional,
    one: (name: string) => flags.get(name)?.[0],
    all: (name: string) => flags.get(name) ?? [],
    bool: (name: string) => flags.get(name)?.[0] === "true",
  };
}


/** A provider failure worth retrying on the same thread, or null. Text-matched: pi reports
 * 429s and connection drops only as provider/error detail, with no errorInfo. */
// ponytail: heuristic regexes; switch to errorInfo.category once providers populate it.
function transientFailure(text: string): { usageLimit: boolean; resetSeconds: number | null } | null {
  const usageLimit = /\b429\b|usage[_ ]limit|rate[_ -]?limit|model_cooldown|quota/i.test(text);
  if (!usageLimit && !/connection error|connection-failed|stream-disconnected|overloaded|ECONNRESET|ETIMEDOUT|socket hang up|\b50[234]\b/i.test(text)) return null;
  const reset = /"?reset_seconds"?\s*[:=]\s*(\d+)/.exec(text);
  return { usageLimit, resetSeconds: reset ? Number(reset[1]) : null };
}


/** Append-only: the host records each statement's hash by index and rejects a changed
 * or reordered one. Exported so the upgrade path can be tested on a real database. */
export const MIGRATIONS = [
    `CREATE TABLE IF NOT EXISTS plugin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS managed_threads (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','worker','reviewer')),
      project_id TEXT NOT NULL,
      chief_thread_id TEXT,
      worker_thread_id TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      lifecycle_alert_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS alert_outbox (
      dedupe_key TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      message TEXT NOT NULL,
      delivered_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS alert_outbox_pending ON alert_outbox (delivered_at, created_at)`,
    `CREATE TABLE IF NOT EXISTS chief_models (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','worker','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    // One row per (worker, base branch): a delta only means something when both
    // cycles scored the same comparison point.
    `CREATE TABLE IF NOT EXISTS jev_scores (
      worker_thread_id TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      evaluation TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (worker_thread_id, base_branch)
    )`,
    `ALTER TABLE managed_threads ADD COLUMN tier TEXT`,
    // SQLite cannot ALTER a CHECK constraint, so the 'worker'/'chief'/'reviewer'
    // key becomes 'junior'/'senior'/'chief'/'reviewer' via a table rebuild.
    // Existing picks under 'worker' survive as 'senior'.
    `CREATE TABLE chief_models_new (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','junior','senior','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    `INSERT INTO chief_models_new (host_id, role, provider_id, model, reasoning_level, updated_at)
      SELECT host_id, CASE role WHEN 'worker' THEN 'senior' ELSE role END, provider_id, model, reasoning_level, updated_at
      FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_new RENAME TO chief_models`,
    `ALTER TABLE managed_threads ADD COLUMN branch TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN issue_url TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN pr_url TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN verdict TEXT`,
    // The brief a worker was delegated with, so its reviewer can judge the change
    // against the same standard instead of an unanchored one.
    `ALTER TABLE managed_threads ADD COLUMN brief TEXT`,
    // Finding 8 asks whether the applicability gate really abstains on thin diffs
    // instead of guessing. jev_scores only keeps the latest evaluation per worker
    // and base, so the answer has to be counted as the scores are produced.
    // ponytail: aggregate counters, not one row per pass — no slicing by project,
    // diff size, or truncation. Add a column pair if the total hides the answer.
    `CREATE TABLE IF NOT EXISTS jev_metric_stats (
      metric TEXT PRIMARY KEY,
      samples INTEGER NOT NULL,
      abstained INTEGER NOT NULL,
      score_sum REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    // Admitting the planner role means widening two CHECK constraints, and SQLite
    // cannot drop one. Both tables are rebuilt; the statements above keep their old
    // text because migrations are append-only. Column order matches the live table,
    // ALTER-added columns last, which is what SELECT * relies on.
    `CREATE TABLE managed_threads_v2 (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer')),
      project_id TEXT NOT NULL,
      chief_thread_id TEXT,
      worker_thread_id TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      lifecycle_alert_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tier TEXT,
      branch TEXT,
      issue_url TEXT,
      pr_url TEXT,
      verdict TEXT,
      brief TEXT
    )`,
    `INSERT INTO managed_threads_v2 SELECT * FROM managed_threads`,
    `DROP TABLE managed_threads`,
    `ALTER TABLE managed_threads_v2 RENAME TO managed_threads`,
    // Dropping the table dropped its index with it.
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    `CREATE TABLE chief_models_v3 (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','junior','senior','reviewer')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    `INSERT INTO chief_models_v3 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v3 RENAME TO chief_models`,
    // A reviewer's active_cycle counts every resume, not rejection rounds.
    // Consecutive request_changes verdicts need their own counter so an
    // unrelated resume can't misread as a deadlock.
    `ALTER TABLE managed_threads ADD COLUMN reject_streak INTEGER NOT NULL DEFAULT 0`,
    // Jev scoring is removed for cost reasons; its tables and settled state go with it.
    `DROP TABLE IF EXISTS jev_scores`,
    `DROP TABLE IF EXISTS jev_metric_stats`,
    `DELETE FROM plugin_meta WHERE key='jev_verified'`,
    // Child threads spawned by Chief or filed under Chief track their parent thread.
    `ALTER TABLE managed_threads ADD COLUMN parent_thread_id TEXT`,
    // Admitting the advisor role means widening two CHECK constraints again, and
    // SQLite still cannot drop one. Same rebuild pattern as managed_threads_v2 /
    // chief_models_v3 above: column order matches the live table, ALTER-added
    // columns last, which is what SELECT * relies on.
    `CREATE TABLE managed_threads_v3 (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor')),
      project_id TEXT NOT NULL,
      chief_thread_id TEXT,
      worker_thread_id TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      lifecycle_alert_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tier TEXT,
      branch TEXT,
      issue_url TEXT,
      pr_url TEXT,
      verdict TEXT,
      brief TEXT,
      reject_streak INTEGER NOT NULL DEFAULT 0,
      parent_thread_id TEXT
    )`,
    `INSERT INTO managed_threads_v3 SELECT * FROM managed_threads`,
    `DROP TABLE managed_threads`,
    `ALTER TABLE managed_threads_v3 RENAME TO managed_threads`,
    // Dropping the table dropped its index with it.
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    `CREATE TABLE chief_models_v4 (
      host_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','junior','senior','reviewer','advisor')),
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      reasoning_level TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host_id, role)
    )`,
    `INSERT INTO chief_models_v4 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v4 RENAME TO chief_models`,
    // The hard stall alert (2x stallMinutes) fires once per active cycle, like the soft one.
    `ALTER TABLE managed_threads ADD COLUMN stop_alerted_cycle INTEGER`,
    // Persisted wave schedule (planner row) and the link a worker delegated from it carries.
    `ALTER TABLE managed_threads ADD COLUMN plan_waves TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN plan_thread_id TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN plan_wave INTEGER`,
    // A reviewer's regression flag, so nextAction can see it on a later call too.
    `ALTER TABLE managed_threads ADD COLUMN regression INTEGER`,
    // A monotonic per-row report counter and a reviewer's snapshot of the worker's
    // count at spawn time — a robust (not timestamp-based) tie between a reviewer
    // and the exact report it covers, immune to same-millisecond collisions and to
    // the reviewer later completing.
    `ALTER TABLE managed_threads ADD COLUMN report_seq INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE managed_threads ADD COLUMN reviewed_report_seq INTEGER`,
    // Worker row only: the reason a delegation skipped chief_plan while planning was on.
    `ALTER TABLE managed_threads ADD COLUMN unplanned_reason TEXT`,
    // Chief's own todos, per project so they survive replacement Chiefs.
    `CREATE TABLE IF NOT EXISTS chief_todos (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, text TEXT NOT NULL, after TEXT, state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','dropped')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS chief_todos_project ON chief_todos (project_id, state, id)`,
    // One worker type: senior picks carry over as worker; junior picks are dropped.
    `CREATE TABLE chief_models_v5 (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role))`,
    `INSERT INTO chief_models_v5 (host_id, role, provider_id, model, reasoning_level, updated_at) SELECT host_id, CASE role WHEN 'senior' THEN 'worker' ELSE role END, provider_id, model, reasoning_level, updated_at FROM chief_models WHERE role <> 'junior'`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v5 RENAME TO chief_models`,
    // Inert legacy column, kept for schema compatibility; nothing reads or writes it.
    `ALTER TABLE managed_threads ADD COLUMN release_pending INTEGER NOT NULL DEFAULT 0`,
    // chief_research's per-machine model pick for each role and stage; no row means inherit the caller's.
    `CREATE TABLE IF NOT EXISTS research_models (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','reviewer')), stage TEXT NOT NULL CHECK(stage IN ('scan','verify','combine')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role, stage))`,
    // One chief_research pick per machine for every stage and role; per-role, per-stage picks are discarded.
    `CREATE TABLE IF NOT EXISTS research_model (host_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    `DROP TABLE IF EXISTS research_models`,
    // chief_research's per-machine pick per mode; the single pick is copied to every mode.
    `CREATE TABLE IF NOT EXISTS research_mode_models (host_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('survey','review','investigate')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, mode))`,
    `INSERT INTO research_mode_models (host_id, mode, provider_id, model, reasoning_level, updated_at) SELECT r.host_id, m.mode, r.provider_id, r.model, r.reasoning_level, r.updated_at FROM research_model r CROSS JOIN (SELECT 'survey' AS mode UNION ALL SELECT 'review' UNION ALL SELECT 'investigate') m`,
    // The single pick now lives on in every mode.
    `DROP TABLE IF EXISTS research_model`,
    // A child Chief's todos are its own: NULL keeps the project-wide scope top-level Chiefs share.
    `ALTER TABLE chief_todos ADD COLUMN chief_thread_id TEXT`,
    // A provider model hit its usage limit; new spawns on it are refused until until_at. model '' rows are legacy and ignored.
    `CREATE TABLE IF NOT EXISTS provider_cooldowns (provider_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', until_at INTEGER NOT NULL, reason TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (provider_id, model))`,
    // One per machine: reviewers and research switch to it while their primary cools down.
    `CREATE TABLE IF NOT EXISTS chief_fallback_model (host_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    // A worker's replaces: predecessor, so a branchless fix chain still groups into one task for bb chief stats.
    `ALTER TABLE managed_threads ADD COLUMN replaces_thread_id TEXT`,
    // bb chief stats counters; neither was recorded before this migration (see stats_since).
    `ALTER TABLE managed_threads ADD COLUMN thread_errors INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE managed_threads ADD COLUMN busy_rejections INTEGER NOT NULL DEFAULT 0`,
    `INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('stats_since', CAST(strftime('%s','now') AS INTEGER) * 1000)`,
    // The per-machine fallback model was removed; a cooling provider is refused outright.
    `DROP TABLE IF EXISTS chief_fallback_model`,
    // A reviewer's full verdict file, handed to the replacement worker, the next reviewer and the advisor.
    `ALTER TABLE managed_threads ADD COLUMN verdict_path TEXT`,
    // A worker's kind ("designer" for design-tool work); NULL reads as a plain worker.
    `ALTER TABLE managed_threads ADD COLUMN kind TEXT`,
    // A Designer model pick; no row inherits the Worker pick.
    `CREATE TABLE chief_models_v6 (host_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor','designer')), provider_id TEXT NOT NULL, model TEXT NOT NULL, reasoning_level TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (host_id, role))`,
    `INSERT INTO chief_models_v6 SELECT * FROM chief_models`,
    `DROP TABLE chief_models`,
    `ALTER TABLE chief_models_v6 RENAME TO chief_models`,
    // Nested Chiefs were removed: existing ones become ordinary top-level Chiefs, and their todos join the project-wide list.
    `UPDATE managed_threads SET chief_thread_id=NULL, state=CASE WHEN state IN ('ready','blocked') THEN 'idle' ELSE state END, blocker=CASE WHEN state='blocked' THEN NULL ELSE blocker END WHERE role='chief' AND chief_thread_id IS NOT NULL`,
    `UPDATE chief_todos SET chief_thread_id=NULL WHERE chief_thread_id IS NOT NULL`,
    // Approaches a worker or reviewer ruled out, carried down a replaces: chain into the successor's brief.
    `ALTER TABLE managed_threads ADD COLUMN fails TEXT`,
    // Shared plan-run log: FACT/FAIL notes workers on one plan read with chief_log, each from its own cursor.
    `CREATE TABLE plan_log (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_thread_id TEXT NOT NULL, author_thread_id TEXT NOT NULL, wave INTEGER, kind TEXT NOT NULL CHECK (kind IN ('FACT','FAIL')), text TEXT NOT NULL, scope TEXT NOT NULL, basis TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE INDEX plan_log_plan ON plan_log(plan_thread_id, id)`,
    `ALTER TABLE managed_threads ADD COLUMN log_read_id INTEGER`,
    // legacy: workers delegated on the retired simple tag; read only by bb chief stats
    `ALTER TABLE managed_threads ADD COLUMN simple INTEGER`,
    // chief_continue stall-clock resets since the last report, so repeated nudges cannot postpone the hard stall alert forever.
    `ALTER TABLE managed_threads ADD COLUMN stall_resets INTEGER NOT NULL DEFAULT 0`,
    // bb chief stats usage tracking; nothing is backfilled, so older rows read as unknown (planner_on NULL) or absent.
    // One row per chief_research call. outcome: succeeded | partial | failed | still_running | timed_out | spawned | start_failed | error.
    `CREATE TABLE chief_research_calls (id INTEGER PRIMARY KEY, caller_thread_id TEXT, role TEXT, mode TEXT, run_id TEXT, outcome TEXT, started_at INTEGER, ended_at INTEGER)`,
    // Worker row only: whether planning was on when it was delegated (1/0); NULL for rows from before this column.
    `ALTER TABLE managed_threads ADD COLUMN planner_on INTEGER`,
    // One row per reviewer verdict report; survives chief_continue (which clears the row's verdict) and replacement reviewers.
    `CREATE TABLE reviewer_verdicts (id INTEGER PRIMARY KEY, reviewer_thread_id TEXT, worker_thread_id TEXT, verdict TEXT, report_seq INTEGER, at INTEGER)`,
    // The last chief_report's short summary and the per-report file holding its full text; both follow `result`.
    `ALTER TABLE managed_threads ADD COLUMN summary TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN report_path TEXT`,
    // Bumped each time chief_complete replaces the result, so a pending report-path publication can tell its result was replaced.
    `ALTER TABLE managed_threads ADD COLUMN result_rev INTEGER NOT NULL DEFAULT 0`,
    // Advisor row only: when it first sent a ready or blocked report (its actual advice). Set once; stop, complete, status sync and later reports never clear it. Old rows stay NULL.
    `ALTER TABLE managed_threads ADD COLUMN advised_at INTEGER`,
    // Durable lessons an advisor recorded at a consult; the newest few are injected into every later managed thread in the project.
    `CREATE TABLE chief_lessons (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, text TEXT NOT NULL, source_thread_id TEXT NOT NULL, worker_thread_id TEXT, at INTEGER NOT NULL)`,
    `CREATE INDEX chief_lessons_project ON chief_lessons(project_id, at)`,
    // Admitting the researcher role widens managed_threads' role CHECK, which SQLite cannot alter, so rebuild it once more
    // (same pattern as managed_threads_v3). Column order is the live table's: v3's columns, then every ALTER-added column in
    // migration order, which INSERT ... SELECT * relies on. If another migration that adds a managed_threads column is
    // merged before this one, list its column here too; a mismatch fails the INSERT loudly instead of dropping data.
    `CREATE TABLE managed_threads_v4 (
      thread_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('chief','planner','worker','reviewer','advisor','researcher')),
      project_id TEXT NOT NULL,
      chief_thread_id TEXT,
      worker_thread_id TEXT,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      status TEXT,
      result TEXT,
      blocker TEXT,
      recommendation TEXT,
      active_since INTEGER,
      active_cycle INTEGER NOT NULL DEFAULT 0,
      stall_alerted_cycle INTEGER,
      lifecycle_alert_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      tier TEXT,
      branch TEXT,
      issue_url TEXT,
      pr_url TEXT,
      verdict TEXT,
      brief TEXT,
      reject_streak INTEGER NOT NULL DEFAULT 0,
      parent_thread_id TEXT,
      stop_alerted_cycle INTEGER,
      plan_waves TEXT,
      plan_thread_id TEXT,
      plan_wave INTEGER,
      regression INTEGER,
      report_seq INTEGER NOT NULL DEFAULT 0,
      reviewed_report_seq INTEGER,
      unplanned_reason TEXT,
      release_pending INTEGER NOT NULL DEFAULT 0,
      replaces_thread_id TEXT,
      thread_errors INTEGER NOT NULL DEFAULT 0,
      busy_rejections INTEGER NOT NULL DEFAULT 0,
      verdict_path TEXT,
      kind TEXT,
      fails TEXT,
      log_read_id INTEGER,
      simple INTEGER,
      stall_resets INTEGER NOT NULL DEFAULT 0,
      planner_on INTEGER,
      summary TEXT,
      report_path TEXT,
      result_rev INTEGER NOT NULL DEFAULT 0,
      advised_at INTEGER
    )`,
    `INSERT INTO managed_threads_v4 SELECT * FROM managed_threads`,
    `DROP TABLE managed_threads`,
    `ALTER TABLE managed_threads_v4 RENAME TO managed_threads`,
    // Dropping the table dropped its index with it.
    `CREATE INDEX IF NOT EXISTS managed_threads_chief ON managed_threads (chief_thread_id, created_at)`,
    // Backlog board: a todo exported to a task ("pending:<id>" while the file is being created), and the task a worker implements.
    `ALTER TABLE chief_todos ADD COLUMN backlog_task_id TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN backlog_task_id TEXT`,
    // The PR head commit a verdict was given for (copied from the reviewer row by the server, never from a report), and the commit a PR-bound reviewer was pinned to at spawn.
    `ALTER TABLE reviewer_verdicts ADD COLUMN head_sha TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN reviewed_head_sha TEXT`,
    // Design-wave worker only: the owner's approval of its artboards as Chief quoted it (chief_owner_approval), and when. A new report or chief_continue clears both.
    `ALTER TABLE managed_threads ADD COLUMN owner_approval TEXT`,
    `ALTER TABLE managed_threads ADD COLUMN owner_approved_at INTEGER`,
    // The state of the row's latest chief_report (ready, blocked, active, idle, failed): row.state moves on once the thread runs again, this does not.
    `ALTER TABLE managed_threads ADD COLUMN last_report_state TEXT`,
    // Rows from before the column: a ready row that has reported provably last reported ready. Active/blocked/idle rows stay NULL (unknown).
    `UPDATE managed_threads SET last_report_state='ready' WHERE state='ready' AND report_seq > 0 AND last_report_state IS NULL`,
    // One review covers every branch of a plan: one row per worker a reviewer covers, with the report and PR head it was bound to. Reviewers from before are backfilled from their own row.
    `CREATE TABLE IF NOT EXISTS review_targets (reviewer_thread_id TEXT NOT NULL, worker_thread_id TEXT NOT NULL, report_seq INTEGER, head_sha TEXT, pr_url TEXT, branch TEXT, PRIMARY KEY (reviewer_thread_id, worker_thread_id))`,
    `INSERT OR IGNORE INTO review_targets (reviewer_thread_id, worker_thread_id, report_seq, head_sha, pr_url, branch) SELECT thread_id, worker_thread_id, reviewed_report_seq, reviewed_head_sha, NULL, branch FROM managed_threads WHERE role='reviewer' AND worker_thread_id IS NOT NULL`,
    // The covered worker's report a verdict row was given for (-1: re-pointed before the verdict); NULL on rows from before, which read the reviewer's reviewed_report_seq.
    `ALTER TABLE reviewer_verdicts ADD COLUMN worker_report_seq INTEGER`,
    // A reviewer's latest structured findings (JSON array of {file, line?, severity, message, fix?}); replaced by each report.
    `ALTER TABLE managed_threads ADD COLUMN findings TEXT`,
    // Who recorded a lesson: 'reviewer' lessons go to later reviewers only; NULL (older rows) or 'advisor' go to every managed thread.
    `ALTER TABLE chief_lessons ADD COLUMN role TEXT`,
    // Worker row only: the shell command the worker's brief makes it run; inherited through replaces:. (Legacy: a removed gate once reran it.)
    `ALTER TABLE managed_threads ADD COLUMN verify_command TEXT`,
    // One row per (source thread, active cycle, kind), written when a transient provider failure or a stall is detected, whether or not its alert is delivered. `detail` is classified from the provider error text only; legacy=1 rows were copied from older alerts and are approximate.
    `CREATE TABLE IF NOT EXISTS chief_failure_events (source_thread_id TEXT NOT NULL, active_cycle INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('provider','stall','hard_stall')), detail TEXT CHECK(detail IS NULL OR detail IN ('usage_limit','connection')), legacy INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, PRIMARY KEY (source_thread_id, active_cycle, kind))`,
    // One-time copy of the surviving failed:/stall: alerts, classified as bb chief stats classified them ("usage limit" in the message), so totals carry over. error: and report: keys are never copied.
    `INSERT OR IGNORE INTO chief_failure_events (source_thread_id, active_cycle, kind, detail, legacy, at)
     SELECT source_thread_id,
       CAST(CASE WHEN dedupe_key LIKE '%:failed:%' THEN substr(dedupe_key, instr(dedupe_key, ':failed:') + 8) ELSE substr(dedupe_key, instr(dedupe_key, ':stall:') + 7) END AS INTEGER),
       CASE WHEN dedupe_key LIKE '%:failed:%' THEN 'provider' WHEN dedupe_key LIKE '%:hard' THEN 'hard_stall' ELSE 'stall' END,
       CASE WHEN dedupe_key LIKE '%:failed:%' THEN CASE WHEN instr(message, 'usage limit') > 0 THEN 'usage_limit' ELSE 'connection' END END,
       1, created_at
     FROM alert_outbox WHERE dedupe_key LIKE '%:failed:%' OR dedupe_key LIKE '%:stall:%'`,
    // Comments to post on a task's pull request or tracking issue. A row is written with the state change it describes and posted off the tool-call path; attempts is persisted before each post, so a crash is read as "maybe posted" and the marker check runs first.
    `CREATE TABLE forge_comments (dedupe_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL, mention INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, posted_at INTEGER, gave_up_at INTEGER, created_at INTEGER NOT NULL)`,
    // Planner row only: the tracking issue shared by every wave of its plan.
    `ALTER TABLE managed_threads ADD COLUMN plan_issue_url TEXT`,
    // Planner row only: its one advisor review — NULL (none needed), 'required', 'approved' or 'changes'.
    `ALTER TABLE managed_threads ADD COLUMN plan_review TEXT`,
    // Legacy: one row per gate thread of the removed review gate; no longer written or read.
    `CREATE TABLE IF NOT EXISTS gate_threads (thread_id TEXT PRIMARY KEY, environment_id TEXT, chief_thread_id TEXT, worker_thread_id TEXT NOT NULL, created_at INTEGER NOT NULL, thread_deleted INTEGER NOT NULL DEFAULT 0, delete_attempts INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0)`,
    // Worker row only: when chief_complete saw a positive approval with cleanupApproved on. NULL (override, skipReview, legacy: workers delegated on the retired simple tag, setting off, rows from before) is never cleaned up.
    `ALTER TABLE managed_threads ADD COLUMN cleanup_approved_at INTEGER`,
    // One row per thread the post-approval cleanup handles: its current step, the generation (archived_at) it archived, and the bounded-retry state of that step.
    `CREATE TABLE IF NOT EXISTS cleanup_jobs (thread_id TEXT PRIMARY KEY, chief_thread_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT, branch TEXT, step TEXT NOT NULL CHECK(step IN ('archive','teardown','branch','storage','done')), step_at INTEGER NOT NULL, archived_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    // A thread whose Chief artifacts were written to its storage root because the BB data dir was unknown: its storage may hold evidence and is never cleared.
    `CREATE TABLE IF NOT EXISTS artifact_fallbacks (thread_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
    // Worker row only: Chief's reason for completing it with chief_complete skipReview (no review); NULL otherwise.
    `ALTER TABLE managed_threads ADD COLUMN review_skipped TEXT`,
    // Worker row only: Chief's reason for completing unplanned work with no tester (chief_complete testsSkipped); NULL otherwise.
    `ALTER TABLE managed_threads ADD COLUMN tests_skipped TEXT`,
];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chiefProject: { type: "project", label: "Default Chief project" },
    stallMinutes: { type: "string", label: "Stall threshold (minutes)", default: "15" },
    plannerEnabled: {
      type: "boolean",
      label: "Plan before delegating",
      description: "Lets Chief send work to a read-only planner first, read the plan, and delegate it.",
      default: true,
    },
    researchEnabled: {
      type: "boolean",
      label: "Researcher",
      description: "Lets Chief and planners run read-only chief_research surveys and investigations as BB workflows. They share one config.",
      default: true,
    },
    researchMaxAgentCalls: { type: "number", label: "Researcher: agent calls per run (1–100)", default: 24, experimental_schema: agentCapSchema },
    researchSurveyTimeoutMinutes: { type: "number", label: "Researcher: survey timeout (minutes, 1–60)", default: RESEARCH_DEFAULT_TIMEOUT_MINUTES, experimental_schema: timeoutSchema },
    researchInvestigateTimeoutMinutes: { type: "number", label: "Researcher: investigate timeout (minutes, 1–60)", default: RESEARCH_DEFAULT_TIMEOUT_MINUTES, experimental_schema: timeoutSchema },
    autoSpawn: {
      type: "boolean",
      label: "Auto-spawn Chief",
      description: "Automatically start a Chief supervisor when BB opens, the default project changes, or an active project Chief is missing.",
      default: false,
    },
    forgeOwnerHandle: {
      type: "string",
      label: "Forge handle to @-mention on escalations",
      description: "Empty = the forge CLI's logged-in user.",
      default: "",
    },
    cascadeArchive: {
      type: "boolean",
      label: "Archive managed threads with their Chief",
      description: "Planners, workers, reviewers, and advisors started while this is on are archived when their Chief is archived — and deleted when it is deleted, worktrees included. Ownership is fixed at start: threads already running keep their current behavior, and a replacement Chief does not inherit the children of the one it replaced.",
      default: true,
    },
    cleanupApproved: {
      type: "boolean",
      label: "Clean up approved work",
      description: "After Chief completes a worker with an approving review (or a design wave with the owner's approval), a background cleanup worker archives its task's threads when nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there. Override and skipped-review (skipReview) completions are never cleaned up.",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  // JS, not strftime, so the pinned snapshot clock sets it; OR IGNORE keeps the first startup's value.
  db.prepare(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('failure_events_since', ?)`).run(String(Date.now()));
  // Threads created before this key cannot be proved free of artifact fallbacks, so their storage is kept.
  db.prepare(`INSERT OR IGNORE INTO plugin_meta (key, value) VALUES ('artifact_fallbacks_since', ?)`).run(String(Date.now()));

  const activeChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND chief_thread_id IS NULL AND project_id=? AND state NOT IN ('failed','deleted','archived','complete') ORDER BY created_at DESC LIMIT 1`,
  );
  const latestChiefForProject = db.prepare<[string]>(
    `SELECT * FROM managed_threads WHERE role='chief' AND chief_thread_id IS NULL AND project_id=? ORDER BY created_at DESC LIMIT 1`,
  );
  const chiefCountForProject = db.prepare<[string]>(
    `SELECT COUNT(*) AS count FROM managed_threads WHERE role='chief' AND chief_thread_id IS NULL AND project_id=?`,
  );
  // Every reviewer of a worker, whatever its state: chainFails reads completed reviewers too.
  const reviewerFails = db.prepare<[string]>(
    `SELECT r.fails FROM managed_threads r JOIN review_targets t ON t.reviewer_thread_id=r.thread_id WHERE r.role='reviewer' AND t.worker_thread_id=? AND r.fails IS NOT NULL ORDER BY r.created_at DESC, r.rowid DESC`,
  );
  const existingBranchReview = db.prepare<[string, string, string]>(
    `SELECT * FROM managed_threads WHERE role='reviewer' AND worker_thread_id IS NULL AND chief_thread_id=? AND project_id=? AND branch=? AND state NOT IN ('complete','archived','deleted') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  );
  // An alert to a Chief that is complete, archived or deleted can never land (handOver
  // retargets a superseded Chief's alerts), so it must not hold one of the 100 retry slots.
  // A live Chief's alerts retry until they land: the worker was told not to report again.
  // A row never attempted waits 60 s: report() writes a fallback row in its transaction and replaces it with the full alert, so a retry must not race that.
  const pendingAlerts = db.prepare<[number]>(
    `SELECT * FROM alert_outbox WHERE delivered_at IS NULL AND (attempts > 0 OR created_at <= ?) AND NOT EXISTS (
      SELECT 1 FROM managed_threads WHERE thread_id=alert_outbox.target_thread_id AND state IN ('complete','archived','deleted')
    ) ORDER BY created_at ASC LIMIT 100`,
  );
  const roleModelRow = db.prepare<[string, string]>(
    `SELECT provider_id, model, reasoning_level FROM chief_models WHERE host_id=? AND role=?`,
  );
  const researchModelRow = db.prepare<[string, string]>(
    `SELECT provider_id, model, reasoning_level FROM research_mode_models WHERE host_id=? AND mode=?`,
  );
  // chief_todos.chief_thread_id is the owning Chief (NULL = legacy, from before ownership).
  const todosForProject = db.prepare<[string]>(
    `SELECT * FROM chief_todos WHERE project_id=? AND state='open' ORDER BY id ASC`,
  );
  const closedTodosForProject = db.prepare<[string]>(
    `SELECT * FROM chief_todos WHERE project_id=? AND state<>'open' ORDER BY id ASC`,
  );
  const todoById = db.prepare<[number, string]>(`SELECT * FROM chief_todos WHERE id=? AND project_id=?`);
  const insertTodo = db.prepare<[string, string, string, string | null, number, number]>(
    `INSERT INTO chief_todos (project_id, chief_thread_id, text, after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateTodo = db.prepare<[string, string | null, string, number, number, string]>(
    `UPDATE chief_todos SET text=?, after=?, state=?, updated_at=? WHERE id=? AND project_id=?`,
  );
  // ponytail: global, not per host: usage limits are account-level; key by host if a provider id ever maps to different accounts per machine.
  // ponytail: cooldowns are per provider+model; legacy model='' rows (provider-wide, from before this) are never matched, so they are inert.
  // ponytail: expired rows are ignored, never cleaned; they are bounded by the provider/model pairs.
  const anyCooldown = db.prepare<[number]>(`SELECT 1 FROM provider_cooldowns WHERE until_at > ? LIMIT 1`);
  const cooldownFor = db.prepare<[string, string, number]>(
    `SELECT provider_id, model, until_at, reason FROM provider_cooldowns WHERE provider_id=? AND model=? AND until_at > ? ORDER BY until_at DESC LIMIT 1`,
  );
  const upsertCooldown = db.prepare<[string, string, number, string, number]>(
    `INSERT INTO provider_cooldowns (provider_id, model, until_at, reason, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model) DO UPDATE SET until_at=MAX(until_at, excluded.until_at), reason=excluded.reason, updated_at=excluded.updated_at`,
  );
  let pendingReady = false; // set once everything pendingSnapshot() touches is initialised
  // The sweep and the Pending publish follow a reload only once pendingReady, as before the store existed.
  const store = createThreadStore<ManagedRow>(db, {
    onReload: () => {
      if (!pendingReady) return;
      // ponytail: sweeps on every reload, O(planners × rows); index by plan_thread_id if rosters grow large.
      void sweep();
      publishPending();
    },
  });
  const ledger = createReviewLedger<ManagedRow>(db, store.get, store);
  const schedule = createWaveSchedule<ManagedRow>(store.rows);
  const { planWavesFor, isDesignWave, isTestWave, waveWorkers, reviewTargetsFor } = schedule;
  let plannerActive = false;
  // The cleanupApproved setting, cached so chief_complete never reads settings: false until the first read, which fails closed.
  let cleanupActive = false;
  // ponytail: cached for wave 2's synchronous configure(); the chief_research gate reads live settings.
  let researchActive: ResearchSettings | null = null;
  const rulesCache = new Map<string, string>();
  const alertDeliveries = new Map<string, Promise<boolean>>();
  const reviewStarts = new Map<string, Promise<{ threadId: string; title: string; workerThreadId: string | null; created: boolean; pinnedSha?: string | null; covers?: string[] }>>();

  let publishedPending: string | null = null; // ponytail: in-memory dedupe; lost on reload → one extra signal
  const terminal = (state: string) => ["complete", "archived", "deleted"].includes(state);
  const progress = createPlanProgress<ManagedRow>(store.rows, schedule, ledger, { terminal, busy: (status) => BUSY_STATUSES.has(status) });
  /** A supporting row whose work was absorbed: a reviewer or advisor of a complete worker,
   * a researcher that reported ready (its report alert carries the result), or a planner once
   * every branch's final wave is complete and every linked worker is terminal. */
  function absorbed(row: ManagedRow) {
    if (terminal(row.state) || BUSY_STATUSES.has(row.state)) return false;
    if (row.role === "researcher") return row.state === "ready";
    if (row.role === "reviewer") {
      const covered = ledger.targets(row.thread_id);
      return covered.length > 0 && covered.every((target) => store.get(target.worker_thread_id)?.state === "complete");
    }
    if (row.role === "advisor") {
      if (row.plan_thread_id) return store.get(row.plan_thread_id)?.state === "complete";
      return !!row.worker_thread_id && store.get(row.worker_thread_id)?.state === "complete";
    }
    if (row.role !== "planner" || !row.plan_waves) return false;
    return progress.plannerAbsorbed(row);
  }
  /** Completes absorbed rows, each only after a fresh threads.get shows it live and not busy.
   * A failed or busy read leaves the row alone (fail closed); a later reload retries. */
  async function completeAbsorbed() {
    let completed = 0;
    for (const id of store.all().filter(absorbed).map((row) => row.thread_id)) {
      const live = await bb.sdk.threads.get({ threadId: id }).catch(() => null);
      if (!live || BUSY_STATUSES.has(live.status) || live.deletedAt !== null || live.archivedAt !== null) continue;
      const row = store.get(id);
      if (!row || !absorbed(row)) continue; // changed while the read was in flight
      store.completeAbsorbed(id, live.status); // refreshes without the sweep: this runs inside it
      completed += 1;
    }
    return completed;
  }
  let sweeping: Promise<void> | null = null;
  let sweepAgain = false;
  /** Single-flight: a reload during a sweep queues exactly one more pass instead of a racing one.
   */
  function sweep() {
    if (sweeping) { sweepAgain = true; return sweeping; }
    sweeping = (async () => {
      do {
        sweepAgain = false;
        if (await completeAbsorbed()) publishPending();
      } while (sweepAgain);
    })().catch((error) => bb.log.warn(`Absorbed-thread sweep failed: ${String(error)}`)).finally(() => { sweeping = null; });
    return sweeping;
  }
  function publishPending() {
    // ponytail: recomputes every Chief's Pending block per reload; debounce if rosters grow large.
    const next = JSON.stringify(pendingSnapshot());
    if (next !== publishedPending) {
      publishedPending = next;
      bb.realtime.publish("pending", null);
    }
  }
  function toManaged(row: ManagedRow): ManagedThread {
    return {
      threadId: row.thread_id,
      role: row.role,
      projectId: row.project_id,
      chiefThreadId: row.chief_thread_id,
      workerThreadId: row.worker_thread_id,
      title: row.title,
      state: row.state,
      status: row.status,
      result: row.result,
      blocker: row.blocker,
      recommendation: row.recommendation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  let sectionEnsuring: Promise<string> | null = null;
  async function ensureSection(): Promise<string> {
    if (sectionEnsuring) return sectionEnsuring;
    sectionEnsuring = (async () => {
      const sections = await bb.sdk.threadSections.list();
      let section = sections.find((candidate) => candidate.name === SECTION_NAME);
      if (!section) section = await bb.sdk.threadSections.create({ name: SECTION_NAME });
      db.prepare(`INSERT INTO plugin_meta (key, value) VALUES ('section_id', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(section.id);
      return section.id;
    })();
    try {
      return await sectionEnsuring;
    } finally {
      sectionEnsuring = null;
    }
  }

  function storedSectionId() {
    return (db.prepare(`SELECT value FROM plugin_meta WHERE key='section_id'`).get() as { value: string } | undefined)?.value ?? null;
  }

  async function readRules(projectId: string) {
    try {
      const file = await bb.sdk.projects.fileContent({ projectId, path: RULES_FILE });
      const content = file.contentEncoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
      const rules = clip(content.trim() || BUILT_IN_RULES, 32_000);
      rulesCache.set(projectId, rules);
      return rules;
    } catch {
      rulesCache.set(projectId, BUILT_IN_RULES);
      return BUILT_IN_RULES;
    }
  }

  async function projectName(projectId: string) {
    try { return (await bb.sdk.projects.get({ projectId })).name; }
    catch { return projectId; }
  }

  function parseSelectionRow(row: unknown): ModelSelection | null {
    const value = row as { provider_id: string; model: string; reasoning_level: string } | undefined;
    if (!value) return null;
    const parsed = modelSelectionSchema.safeParse({
      providerId: value.provider_id,
      model: value.model,
      reasoningLevel: value.reasoning_level,
    });
    return parsed.success ? parsed.data : null;
  }

  function readRoleModel(hostId: string, role: ModelRole): ModelSelection | null {
    return parseSelectionRow(roleModelRow.get(hostId, role));
  }


  function readResearchModel(hostId: string, mode: ResearchMode): ModelSelection | null {
    return parseSelectionRow(researchModelRow.get(hostId, mode));
  }

  function writeResearchModel(hostId: string, mode: ResearchMode, selection: ModelSelection | null) {
    if (!selection) {
      db.prepare(`DELETE FROM research_mode_models WHERE host_id=? AND mode=?`).run(hostId, mode);
      return;
    }
    db.prepare(`INSERT INTO research_mode_models (host_id, mode, provider_id, model, reasoning_level, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, mode) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model,
        reasoning_level=excluded.reasoning_level, updated_at=excluded.updated_at`).run(
      hostId, mode, selection.providerId, selection.model, selection.reasoningLevel, Date.now(),
    );
  }

  function writeRoleModel(hostId: string, role: ModelRole, selection: ModelSelection | null) {
    if (!selection) {
      db.prepare(`DELETE FROM chief_models WHERE host_id=? AND role=?`).run(hostId, role);
      return;
    }
    db.prepare(`INSERT INTO chief_models (host_id, role, provider_id, model, reasoning_level, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(host_id, role) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model,
        reasoning_level=excluded.reasoning_level, updated_at=excluded.updated_at`).run(
      hostId, role, selection.providerId, selection.model, selection.reasoningLevel, Date.now(),
    );
  }

  // Discovery must never outlive the plugin or hang a spawn behind an
  // unreachable machine, so every catalog read is aborted on both.
  const discoveryLifetime = new AbortController();
  bb.onDispose(() => discoveryLifetime.abort());

  function discover<T>(run: (signal: AbortSignal) => Promise<T>, label: string) {
    const controller = new AbortController();
    const stop = () => controller.abort();
    discoveryLifetime.signal.addEventListener("abort", stop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stop();
          reject(new Error(`${label} timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1_000} seconds.`));
        }, MODEL_DISCOVERY_TIMEOUT_MS);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      discoveryLifetime.signal.removeEventListener("abort", stop);
    });
  }

  function modelCatalog(hostId: string, providerId?: string) {
    return discover(
      (signal) => bb.sdk.providers.models({ hostId, ...(providerId ? { providerId } : {}), signal }),
      "Model discovery",
    );
  }

  type Catalog = (providerId: string) => ReturnType<typeof modelCatalog>;

  /** One scan per provider per request: three roles on one provider must not cost three reads. */
  function catalogReader(hostId: string): Catalog {
    const pending = new Map<string, ReturnType<typeof modelCatalog>>();
    return (providerId) => {
      const started = pending.get(providerId) ?? modelCatalog(hostId, providerId);
      pending.set(providerId, started);
      return started;
    };
  }

  /** The first signed-in provider's default model: what the picker starts from. */
  async function hostFallback(
    hostId: string,
    read: Catalog = catalogReader(hostId),
  ): Promise<{ fallback: ModelSelection | null; error: string | null }> {
    try {
      const providers = await discover(
        (signal) => bb.sdk.providers.list({ hostId, signal }),
        "Provider discovery",
      );
      const provider = providers.find((candidate) => candidate.available);
      if (!provider) return { fallback: null, error: "No signed-in provider on this machine." };
      const catalog = await read(provider.id);
      if (catalog.modelLoadError !== null) {
        return { fallback: null, error: `Model catalog is not available (${catalog.modelLoadError.code}).` };
      }
      const model = catalog.models.find((candidate) => candidate.isDefault) ?? catalog.models[0];
      if (!model) return { fallback: null, error: "This machine reported no models." };
      return {
        fallback: { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort },
        error: null,
      };
    } catch (error) {
      return { fallback: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The stored pick as the machine can serve it today, or null when it cannot.
   * Settings and the spawn sites share this so what the user sees is what runs.
   */
  async function usableSelection(
    hostId: string,
    selection: ModelSelection,
    read: Catalog = catalogReader(hostId),
  ): Promise<ModelSelection | null> {
    try {
      const catalog = await read(selection.providerId);
      if (catalog.modelLoadError !== null) {
        throw new Error(`model catalog is not available (${catalog.modelLoadError.code})`);
      }
      const model = catalog.models.find((candidate) => candidate.model === selection.model);
      if (!model) throw new Error("the machine no longer offers that model");
      const reasoningLevel = model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === selection.reasoningLevel,
      ) ? selection.reasoningLevel : model.defaultReasoningEffort;
      return { ...selection, reasoningLevel };
    } catch (error) {
      bb.log.warn(
        `Chief model ${selection.providerId}/${selection.model} is unusable on ${hostId}; using the BB default instead: ${String(error)}`,
      );
      return null;
    }
  }

  /**
   * Spawn arguments for a role. No selection, an unknown host, or a selection
   * the machine can no longer serve all fall through to BB's own defaults —
   * a stale pick must not block the work.
   */
  // Spread into child spawns only; BB cascades archive/delete from the owner.
  async function lifecycleOwner(chiefThreadId: string | null) {
    return chiefThreadId && (await settings.get()).cascadeArchive ? { lifecycleOwnerThreadId: chiefThreadId } : {};
  }

  async function execution(role: ModelRole, hostId: string | null) {
    const fallback = MODEL_FALLBACK[role];
    const selection = hostId === null
      ? null
      // No Designer row inherits the Worker pick; a stored but unservable one goes to BB default.
      : readRoleModel(hostId, role) ?? (fallback ? readRoleModel(hostId, fallback) : null);
    if (!hostId || !selection) return {};
    return (await usableSelection(hostId, selection)) ?? {};
  }

  /** The project's default execution options, or null; the fake host lacks the method, so a sync throw must be caught too. */
  async function projectDefaults(projectId: string) {
    try {
      const options = await bb.sdk.projects.defaultExecutionOptions({ projectId });
      return options?.providerId ? { providerId: options.providerId, model: options.model ?? "" } : null;
    } catch {
      return null;
    }
  }

  /** execution(), refused while the provider/model it would run on cools down. Fails open when the target is unknown. */
  async function spawnExecution(role: ModelRole, hostId: string | null, projectId: string) {
    const selection = await execution(role, hostId);
    if (!anyCooldown.get(Date.now())) return selection;
    const target = "providerId" in selection ? selection as { providerId: string; model: string } : await projectDefaults(projectId);
    const cooling = target && cooldownError(target.providerId, target.model);
    if (cooling) throw cooling;
    return selection;
  }

  function cooldownError(providerId: string, model: string) {
    if (!model) return null;
    const row = cooldownFor.get(providerId, model, Date.now()) as { until_at: number } | undefined;
    if (!row) return null;
    const minutes = Math.max(1, Math.ceil((row.until_at - Date.now()) / 60_000));
    return new Error(`Provider ${providerId} model ${model} hit its usage limit and is cooling down until ${new Date(row.until_at).toISOString()} (about ${minutes} min). Starting new work on it now would fail the same way. Wait for the reset, retry the failed thread with bb thread retry <id> --send-at ${minutes + 1}m, or pick another model for this role in Chief settings.`);
  }

  async function defaultHostId() {
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
    if (!host) throw new Error("No BB host is registered; a host is required for a managed worktree.");
    return host.id;
  }

  /** The machine a role's thread will actually run on, or null when unknown. */
  async function projectHostId(projectId: string) {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source?.hostId ?? await defaultHostId();
    } catch (error) {
      bb.log.warn(`Could not resolve the machine for ${projectId}: ${String(error)}`);
      return null;
    }
  }

  /** The target project's own local checkout path, or null when unknown. */
  async function projectPath(projectId: string) {
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      return source?.path ?? null;
    } catch (error) {
      bb.log.warn(`Could not resolve the checkout path for ${projectId}: ${String(error)}`);
      return null;
    }
  }

  async function environmentHostId(environmentId: string) {
    try {
      return (await bb.sdk.environments.get({ environmentId })).hostId;
    } catch (error) {
      bb.log.warn(`Could not resolve the machine for ${environmentId}: ${String(error)}`);
      return null;
    }
  }

  function chiefForProject(projectId: string) {
    return (activeChiefForProject.get(projectId) as ManagedRow | undefined) ?? null;
  }

  /** The Chief a spawn request belongs to: the calling Chief itself, or the active
   * one for the caller's project. Planning and delegation resolve it the same way. */
  async function owningChief(callerThreadId?: string | null) {
    const caller = callerThreadId ? store.get(callerThreadId) : undefined;
    const projectId = caller?.project_id ?? (await settings.get()).chiefProject;
    if (!projectId) throw new Error("No Chief project is configured.");
    const chief = caller?.role === "chief" ? caller : chiefForProject(projectId);
    if (!chief || chief.state === "complete") throw new Error("Start Chief for this project first.");
    return { chief, projectId };
  }

  /** bb.agents.configure is synchronous and can only read the cached copy, so every
   * read refreshes it. Spawning a planner gates on this live call, never on the cache. */
  async function plannerEnabled() {
    plannerActive = (await settings.get()).plannerEnabled;
    return plannerActive;
  }

  function researchFrom(values: Awaited<ReturnType<typeof settings.get>>): ResearchSettings {
    return {
      enabled: values.researchEnabled,
      maxAgentCalls: values.researchMaxAgentCalls,
      timeoutMinutes: {
        survey: values.researchSurveyTimeoutMinutes,
        investigate: values.researchInvestigateTimeoutMinutes,
      },
    };
  }

  /** A live read that also refreshes the cache. The chief_research gate calls this, never the cache. */
  async function researchSettings() {
    researchActive = researchFrom(await settings.get());
    return researchActive;
  }

  // Not on managedSpawn: it picks the model after building its prompt, skips the cooldown check, hands over between spawn and insert, and has no parent or brief file.
  async function spawnChief(target: string, previous?: ManagedRow, handoff?: ChiefHandoff) {
    const sectionId = await ensureSection();
    const name = await projectName(target);
    // Only to warm rulesCache: bb.agents.configure reads it synchronously and puts
    // the rules into every Chief turn, so the spawn prompt does not repeat them.
    await readRules(target);
    const count = (chiefCountForProject.get(target) as { count: number }).count;
    const title = handoff ? `Chief · ${name} · ${handoff.title}` : count === 0 ? `Chief · ${name}` : `Chief · ${name} · ${count + 1}`;
    const prompt = [
      `You are Chief for ${name}. You supervise the ordinary BB threads in the Chief sidebar section.`,
      "",
      "You own the forge for every delegation: run chief_forge_init (unplanned work: pass the mission, successCriteria and constraints you will give chief_delegate, since the pull request body is the reviewer's brief), and pass the branch, issueUrl and prUrl it returns to chief_delegate. If it returns a script instead, run it from the project checkout and use the CHIEF_FORGE line it prints. The chief skill's Git workflow section has the rest.",
      "Lifecycle alerts are prompts to decide: continue, review, complete, or escalate. Escalate genuine product, scope, permission, credential, or irreversible decisions here to the user with your recommendation.",
      "",
      "Call chief_roster for the current work list, then wait for work.",
      ...(handoff ? ["", handoffSection(handoff)] : []),
    ].join("\n");
    const thread = await bb.sdk.threads.spawn({
      projectId: target,
      environment: { type: "project-default" },
      sectionId,
      visibility: "visible",
      title,
      ...(await execution("chief", await projectHostId(target))),
      prompt,
      pluginMetadata: { role: "chief" },
    });
    if (previous && previous.thread_id !== thread.id) handOver(previous.thread_id, thread.id, target);
    store.insert({
      threadId: thread.id, role: "chief", projectId: target, title, state: "starting", status: thread.status,
    });
    void pinPendingTab(thread.id);
    return { threadId: thread.id, created: true as const };
  }

  /** The handed-off task as a new Chief reads it: its first message ends with this text, and brief.md holds the same text. */
  function handoffSection(handoff: ChiefHandoff) {
    return [
      "## Handed-off task",
      `Handed off by Chief ${handoff.fromChiefThreadId}. It keeps no link to you: it will not see your roster or alerts, and you do not report to it.`,
      "",
      "### Owner's request (verbatim)",
      handoff.request,
      "",
      "### Context",
      handoff.context,
      "",
      "Own this task through completion under your normal rules. Start with chief_roster. Plan it with your own chief_plan when planning applies; the handing-off Chief's planners, workers and reviewers stay with it, so their plan, report and verdict files are evidence only. Then forge, delegate, review and complete. The handoff is evidence, not proof. This handoff is saved at $BB_THREAD_STORAGE/brief.md; re-read it after any context compaction.",
    ].join("\n");
  }

  /** Supersedes a Chief: marks it complete and moves its open work, todos and undelivered alerts to its successor. */
  function handOver(previousId: string, nextId: string, projectId: string) {
    const now = Date.now();
    store.batch(() => {
      store.completeChief(previousId, now);
      store.moveOpenWork(nextId, now, projectId, previousId);
      db.prepare(`UPDATE alert_outbox SET target_thread_id=?
        WHERE target_thread_id=? AND delivered_at IS NULL`).run(nextId, previousId);
      db.prepare(`UPDATE chief_todos SET chief_thread_id=? WHERE chief_thread_id=?`).run(nextId, previousId);
    });
  }

  /** Best-effort: appends the pending panel tab to a Chief thread once. Never throws. */
  async function pinPendingTab(threadId: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { revision, tabs } = await bb.sdk.threads.tabs.get({ threadId });
        if (tabs.some((tab) => tab.kind === "plugin-panel" && tab.pluginId === bb.pluginId && tab.actionId === "pending")) return;
        await bb.sdk.threads.tabs.update({
          threadId, expectedRevision: revision,
          tabs: [...tabs, {
            // Must match the host's id so opening the action finds this tab: get-bb/bb
            // packages/client-core/src/panel/fixed-panel-tabs-state.ts buildFixedPanelTabId.
            kind: "plugin-panel", id: `plugin-panel:${encodeURIComponent(`${bb.pluginId}:pending:`)}:none`, pluginId: bb.pluginId,
            actionId: "pending", title: "Chief to-do", paramsJson: null,
          }],
        });
        return;
      } catch (error) {
        // ponytail: retries any error once, not only revision conflicts
        if (attempt === 1) bb.log.warn(`Could not pin the pending tab on ${threadId}: ${String(error)}`);
      }
    }
  }

  async function createChief(projectId: string, handoff?: ChiefHandoff) {
    return spawnChief(projectId, undefined, handoff);
  }

  const chiefStarts = new Map<string, Promise<{ threadId: string; created: boolean }>>();
  async function ensureChief(projectId?: string) {
    const values = await settings.get();
    const target = projectId ?? values.chiefProject;
    if (!target) throw new Error("Configure a default Chief project first: bb plugin config chief set chiefProject <proj-id>");
    const inFlight = chiefStarts.get(target);
    if (inFlight) return inFlight;
    const start = (async () => {
      const existing = chiefForProject(target);
      if (existing) {
        await reconcileThread(existing, await ensureSection());
        const reconciled = store.get(existing.thread_id);
        if (reconciled && !["failed", "deleted", "archived", "complete"].includes(reconciled.state)) {
          return { threadId: existing.thread_id, created: false };
        }
      }
      const previous = latestChiefForProject.get(target) as ManagedRow | undefined;
      return spawnChief(target, previous);
    })();
    chiefStarts.set(target, start);
    try {
      return await start;
    } finally {
      chiefStarts.delete(target);
    }
  }

  const managedSpawn = createManagedSpawn({ bb, db, spawnExecution, ensureSection, readRules, lifecycleOwner, insertThread: store.insert, persistBrief });

  /** A plan is read-only work in the project-default environment — its own worktree in projects whose default is a worktree, else the project checkout. Nothing is implemented until Chief delegates. */
  async function startPlan(params: z.infer<typeof planParams>, callerThreadId?: string | null) {
    if (!(await plannerEnabled())) {
      throw new Error("Planning is off. Turn on “Plan before delegating” in Chief's settings, or delegate this work directly.");
    }
    const { chief, projectId } = await owningChief(callerThreadId);
    const revision = params.revises ? revisionInput(params.revises, chief.thread_id) : undefined;
    const prepared = await managedSpawn.prepare(projectId, { role: "planner", hostId: await projectHostId(projectId) });
    const title = `Plan · ${params.title.replace(/^Plan · /, "")}`;
    const prompt = plannerBrief({
      title: params.title, chiefThreadId: chief.thread_id, mission: params.mission, context: params.context,
      research: researchLine("planner", await researchSettings()) !== null, revision,
    });
    const thread = await managedSpawn.launch(prepared, { projectId, environment: { type: "project-default" }, title, prompt },
      { role: "planner", chiefThreadId: chief.thread_id, replacesThreadId: params.revises ?? null },
      // Earlier revision attempts that failed or stopped are superseded atomically with the new one.
      params.revises ? (newId) => {
        const now = Date.now();
        for (const earlier of revisionsOf(params.revises!).all) {
          if (earlier.thread_id !== newId && !BUSY_STATUSES.has(earlier.state) && !terminal(earlier.state)) store.completeSuperseded(earlier.thread_id, now);
        }
      } : undefined);
    return { threadId: thread.id, title, projectId };
  }

  /** chief_plan revises: P is allowed only once P's one review asked for changes and no revision is in or working; returns the revision brief input. */
  function revisionInput(plannerId: string, chiefThreadId: string): NonNullable<Parameters<typeof plannerBrief>[0]["revision"]> {
    const planner = store.get(plannerId);
    if (!planner || planner.role !== "planner" || !controlsThread(planner, chiefThreadId)) throw new Error(`No managed planner ${plannerId} for this Chief.`);
    if (planner.plan_review !== "changes") {
      if (!planner.plan_review && planner.replaces_thread_id) throw new Error(`${plannerId} is already the revision of ${planner.replaces_thread_id}; a revision gets no review — delegate its waves.`);
      throw new Error(planReviewRefusal(planner) ?? `Plan ${plannerId} needs no revision: only a plan whose one advisor review asked for changes is revised. Delegate it.`);
    }
    const revisions = revisionsOf(plannerId);
    if (planner.state === "complete") throw new Error(`Plan ${plannerId} was revised by ${revisions.ready?.thread_id ?? "an earlier revision"}: delegate ${revisions.ready?.thread_id ?? "its"} waves.`);
    if (revisions.busy) throw new Error(`Plan ${plannerId} is being revised by ${revisions.busy.thread_id}: wait for ${revisions.busy.thread_id}.`);
    const decider = planAdvisors(plannerId).decider!;
    const blocked = decider.last_report_state === "blocked";
    return {
      plannerThreadId: plannerId,
      planPaths: planWavesFor(plannerId).map((wave) => wave.path),
      advisorThreadId: decider.thread_id,
      advisorReportPath: decider.report_path,
      advisorSummary: decider.summary ?? (decider.result ? clip(decider.result, 800) : null),
      ...(blocked ? { blocker: decider.blocker, recommendation: decider.recommendation } : {}),
    };
  }

  /** A consult is read-only, like a review: with a worker it reuses that
   * worker's worktree so the advisor can reproduce the failing change; without
   * one it runs in the project's own checkout, like a plan. */
  async function startConsult(params: z.infer<typeof consultParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await owningChief(callerThreadId);
    if (params.planThreadId) return startPlanConsult(params, params.planThreadId, chief.thread_id, projectId);
    const worker = params.workerThreadId ? store.get(params.workerThreadId) : undefined;
    if (params.workerThreadId && (!worker || worker.role !== "worker" || !controlsThread(worker, chief.thread_id))) {
      throw new Error(`No managed worker ${params.workerThreadId} for this Chief.`);
    }
    let workerLive: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
    if (worker) {
      workerLive = await bb.sdk.threads.get({ threadId: worker.thread_id });
      if (BUSY_STATUSES.has(workerLive.status)) busyRejection(worker, workerLive.status, "starting a consult");
      if (workerLive.deletedAt !== null || workerLive.archivedAt !== null) throw new Error(`Worker ${worker.thread_id} is not consultable.`);
      if (!workerLive.environmentId) throw new Error(`Worker ${worker.thread_id} has no reusable environment.`);
    }
    const hostId = worker ? await environmentHostId(workerLive!.environmentId!) : await projectHostId(projectId);
    const prepared = await managedSpawn.prepare(projectId, { role: "advisor", hostId });
    const title = `Consult · ${params.title.replace(/^Consult · /, "")}`;
    const reviews = worker ? taskReviews(worker) : [];
    const prompt = advisorBrief({ title: params.title, chiefThreadId: chief.thread_id, mission: params.mission, context: params.context, worker, reviews });
    const thread = await managedSpawn.launch(prepared, {
      projectId,
      environment: worker
        ? { type: "reuse", environmentId: workerLive!.environmentId! }
        : { type: "project-default" },
      title, prompt,
    }, { role: "advisor", chiefThreadId: chief.thread_id, workerThreadId: worker?.thread_id ?? null });
    return { threadId: thread.id, title, projectId };
  }

  /** chief_consult planThreadId: the plan's one read-only advisor review, in the project's own checkout. */
  async function startPlanConsult(params: z.infer<typeof consultParams>, plannerId: string, chiefThreadId: string, projectId: string) {
    if (params.workerThreadId) throw new Error("Use one of workerThreadId or planThreadId.");
    const planner = store.get(plannerId);
    if (!planner || planner.role !== "planner" || !controlsThread(planner, chiefThreadId) || !planner.plan_waves || planner.state === "complete") {
      throw new Error(`No managed planner ${plannerId} with an open plan for this Chief.`);
    }
    if (planner.plan_review !== "required") {
      if (!planner.plan_review) throw new Error(`Only a multi-wave or complex plan gets an advisor review; ${plannerId} does not (a revision never does): delegate it.`);
      const { decider } = planAdvisors(plannerId);
      throw new Error(`Plan ${plannerId} already had its one review (${decider?.thread_id ?? "?"}): ${planReviewRefusal(planner) ?? nextAction(planner) ?? "delegate its waves."}`);
    }
    const { inFlight } = planAdvisors(plannerId);
    if (inFlight) throw new Error(`Plan ${plannerId} is already in review by ${inFlight.thread_id}: wait for ${inFlight.thread_id}, or chief_stop it first.`);
    const prepared = await managedSpawn.prepare(projectId, { role: "advisor", hostId: await projectHostId(projectId) });
    const title = `Consult · ${params.title.replace(/^Consult · /, "")}`;
    const prompt = advisorBrief({
      title: params.title, chiefThreadId, mission: params.mission, context: params.context, reviews: [],
      plan: {
        plannerThreadId: plannerId, paths: planWavesFor(plannerId).map((wave) => wave.path),
        summary: planner.result ? clip(planner.result, 1_500) : null, reportPath: planner.report_path,
      },
    });
    const thread = await managedSpawn.launch(prepared, { projectId, environment: { type: "project-default" }, title, prompt },
      { role: "advisor", chiefThreadId, planThreadId: plannerId });
    return { threadId: thread.id, title, projectId };
  }

  // ponytail: one delegation at a time, so a second call on the same branch sees the first
  // one's row in the holder check below; per-branch queues if parallel spawns get slow.
  let delegating: Promise<unknown> = Promise.resolve();
  function delegate(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const run = delegating.then(() => startWorker(params, callerThreadId));
    delegating = run.catch(() => undefined);
    return run;
  }

  /** Fails ruled out along a replaces: chain, newest first, from worker threadId back to the chain head. */
  function chainFails(threadId: string): FailEntry[] {
    // Stored oldest-first; `at` is the report time (absent on older rows, which sort as oldest).
    type Stored = FailEntry & { at?: number };
    const parse = (json: string | null) => (json ? JSON.parse(json) as Stored[] : []).reverse();
    const all: Stored[] = [];
    for (const id of ledger.taskChain(threadId)) {
      const worker = store.get(id);
      if (!worker) continue;
      const reviewers = (reviewerFails.all(id) as { fails: string }[]).flatMap((row) => parse(row.fails));
      all.push(...parse(worker.fails), ...reviewers);
    }
    // Newest first across workers and reviewers, before dedup and the cap, so the latest basis wins.
    all.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const seen = new Set<string>();
    const out: FailEntry[] = [];
    for (const entry of all) {
      const key = `${entry.scope}\u0000${entry.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: clip(entry.text, 400), scope: clip(entry.scope, 120), basis: clip(entry.basis, 200) });
      if (out.length >= MAX_CARRIED_FAILS) break;
    }
    return out;
  }

  async function startWorker(params: z.infer<typeof delegateParams>, callerThreadId?: string | null) {
    const { chief, projectId } = await owningChief(callerThreadId);
    const prior = params.replaces ? store.get(params.replaces) : undefined;
    if (params.replaces && (!prior || prior.role !== "worker" || !controlsThread(prior, chief.thread_id) || prior.project_id !== projectId)) {
      throw new Error(`No managed worker ${params.replaces} for this Chief.`);
    }
    if (prior) {
      // The escalation ladder: round 2 needs a consult that gave its advice on this task, round 3 needs the user.
      // Read from the task's verdict history, not the open reviewer: a fresh or completed reviewer,
      // a re-pointed snapshot, or a second replaces: before the next review must not reset it.
      const { streak } = ledger.taskRejections(prior.thread_id);
      const rung = ledger.rung(streak);
      if (rung === "stop" && !params.userApprovedRound) {
        throw new Error(`The reviewer has requested changes ${streak} times in a row on ${prior.thread_id}. Do not delegate another round: escalate to the user with both positions, the consult's advice and your recommendation. Only the user can authorize another round; once they do, repeat this call with userApprovedRound: true (CLI: --user-approved-round).`);
      }
      if (rung === "consult" && !ledger.consultGate(prior)) {
        throw new Error(`The reviewer has requested changes ${streak} times in a row on ${prior.thread_id}. Call chief_consult (workerThreadId: ${prior.thread_id}) and wait for it to send its advice (a ready or blocked report; a status-only, stopped or completed-unreported consult does not count) before delegating the one more round.`);
      }
    }
    let priorLive: Awaited<ReturnType<typeof bb.sdk.threads.get>> | undefined;
    if (prior) {
      priorLive = await waitIdleAfterReport(prior);
      if (BUSY_STATUSES.has(priorLive.status)) busyRejection(prior, priorLive.status, "replacing it");
      if (priorLive.deletedAt !== null || priorLive.archivedAt !== null) throw new Error(`Worker ${prior.thread_id} is not replaceable.`);
      if (!priorLive.environmentId) throw new Error(`Worker ${prior.thread_id} has no reusable environment.`);
      if (params.branch && params.branch !== prior.branch) throw new Error(`replaces: ${prior.thread_id} carries branch ${prior.branch}; pass no --branch or the same one.`);
    }
    const resolved = resolveDelegation(params, prior);
    const { branch, issueUrl, prUrl, planThreadId, wave, verifyCommand, unplannedReason } = resolved;
    let kind = resolved.kind;
    // Planning on means every new delegation starts from a plan wave. replaces: hands off
    // an already-gated delegation, so it passes; the escape hatch must say why.
    const plannerOn = await plannerEnabled();
    if (planThreadId === undefined && !prior && !params.unplannedReason && plannerOn) {
      throw new Error("Planning is on: call chief_plan first, then delegate its waves with planThreadId and wave. To skip the plan, pass unplannedReason (CLI: --unplanned-reason) with your reason.");
    }
    let planPath: string | undefined;
    let waveTotal: number | undefined;
    let waveNext: number | null = null;
    let waveIndependent = false;
    let designWave = false;
    let implementsDesign: number | null = null;
    let contracts: string | undefined;
    let specSources: string[] = [];
    // Replacing a tester needs an explicit kind, so a product fix never lands on a tester by default.
    const explicitKind = "Name the kind: kind: worker to change product code, kind: tester to change tests.";
    if (prior?.kind === "tester" && params.kind === undefined) throw new Error(explicitKind);
    if (planThreadId !== undefined) {
      const planner = store.get(planThreadId);
      if (!planner || planner.role !== "planner" || !controlsThread(planner, chief.thread_id)) {
        throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      }
      const reviewRefusal = planReviewRefusal(planner);
      if (reviewRefusal) throw new Error(reviewRefusal);
      const waves = planWavesFor(planThreadId);
      if (wave === undefined || wave < 1 || wave > waves.length) {
        throw new Error(`Wave ${wave ?? "?"} is out of range: planner ${planThreadId} scheduled ${waves.length} wave(s).`);
      }
      const scheduled = waves[wave - 1]!;
      planPath = scheduled.path;
      waveTotal = waves.length;
      waveNext = successorOf(waves, wave);
      waveIndependent = wave > 1 && parentOf(waves, wave) === null && !prior;
      contracts = scheduled.contracts;
      // A design-only wave draws as a designer unless the caller named a kind.
      designWave = !!scheduled.design;
      if (designWave && params.kind === undefined) kind = "designer";
      const parent = parentOf(waves, wave);
      if (parent !== null && waves[parent - 1]?.design) implementsDesign = parent;
      if (scheduled.absent) throw new Error(`Wave ${wave}'s tests were skipped (${scheduled.testsSkipped}); nothing to delegate.`);
      if (scheduled.test) {
        // A test wave continues its parent's branch: its first hand-off replaces the parent wave's worker.
        const onPlan = prior?.plan_thread_id === planThreadId;
        const sameWave = onPlan && prior!.plan_wave === wave;
        if (!onPlan || !(sameWave || prior!.plan_wave === parent)) {
          const parentWorker = parent !== null ? waveWorkers(planThreadId, parent).at(-1) : undefined;
          throw new Error(`Wave ${wave} is a test wave: it runs on wave ${parent}'s branch. Delegate it as chief_delegate (planThreadId: ${planThreadId}, wave: ${wave}, replaces: ${parentWorker?.thread_id ?? `<wave ${parent}'s latest worker>`}, kind: tester).`);
        }
        if (params.kind === undefined) {
          if (sameWave) throw new Error(explicitKind);
          kind = "tester";
        }
        if (kind === "designer") throw new Error(`Wave ${wave} is a test wave: a designer cannot run it. Use kind: tester, or kind: worker to fix product code on it.`);
        if (kind === "worker" && !sameWave) throw new Error(`Wave ${wave} is a test wave: its first hand-off is kind: tester. kind: worker only replaces a worker on wave ${wave}, to fix product code.`);
      } else if (kind === "tester" && waves.some((other) => other.test)) {
        throw new Error(`Wave ${wave} is not a test wave: a tester runs only this plan's test waves (${waves.flatMap((other, index) => other.test ? [index + 1] : []).join(", ")}).`);
      } else if (kind === "tester" && !prior) {
        throw new Error("kind: tester on a plan with no test wave needs replaces: of the worker whose branch it tests.");
      }
      if (kind === "tester") {
        for (const n of chainOf(waves, wave)) {
          const entry = waves[n - 1]!;
          specSources.push(`Wave ${n} of ${waves.length}: ${entry.path}`, ...(entry.contracts ? [clip(entry.contracts, 3_000)] : []));
          if (entry.design) {
            const designer = waveWorkers(planThreadId, n).at(-1);
            specSources.push(`Approved design: wave ${n}'s artboards, owner's approval “${designer?.owner_approval ?? "none recorded"}”, designer report ${designer?.report_path ?? "none"}`);
          }
        }
      }
    } else if (kind === "tester") {
      if (!prior) throw new Error("kind: tester on unplanned work needs replaces: of the worker whose branch it tests.");
      const head = store.get(ledger.taskChain(prior.thread_id).at(-1)!);
      if (head?.brief) specSources = [clipMiddle(head.brief, 4_000)];
    }
    if (implementsDesign !== null) {
      // The design worker whose artboards this wave builds on: the one being replaced, else the wave's latest.
      const designer = prior && prior.plan_thread_id === planThreadId && prior.plan_wave === implementsDesign
        ? prior
        : waveWorkers(planThreadId!, implementsDesign).at(-1);
      if (!designer?.owner_approval) {
        throw new Error(`Wave ${implementsDesign} is design-only and wave ${wave} implements it: the owner must approve its artboards first. ${designer ? `Show the user the artboards from ${designer.thread_id}'s report, then record their decision with chief_owner_approval (workerThreadId: ${designer.thread_id}) and repeat this call.` : `No worker has delegated wave ${implementsDesign} yet.`}`);
      }
    }
    // One task branch carries one active worker: a second worktree cannot check out a
    // branch another one already holds, and the spawn would fail with a raw git error.
    const holder = branch
      ? store.all().find((row) => row.role === "worker" && !terminal(row.state)
        && row.project_id === projectId && row.branch === branch && row.thread_id !== params.replaces)
      : undefined;
    if (holder) {
      throw new Error(`Branch ${branch} already carries the active worker “${holder.title}” (${holder.thread_id}). Complete that worker, or give this delegation its own branch and pull request.`);
    }
    const hostId = prior ? await environmentHostId(priorLive!.environmentId!) : (await projectHostId(projectId)) ?? await defaultHostId();
    // shortcut: a tester spawns on the Worker pick; a tester pick needs a chief_models rebuild and an app.tsx row, upgrade when the owner asks.
    const prepared = await managedSpawn.prepare(projectId, { role: kind === "tester" ? "worker" : kind, hostId });
    const planContextLine = planPath !== undefined ? `Plan file (wave ${wave} of ${waveTotal}): ${planPath}` : undefined;
    // Read before the reviewer row is re-pointed below, so a `replaces` chain always
    // hands the fresh worker the review that prompted the handoff.
    const findings = prior ? ledger.openReview(prior.thread_id) : undefined;
    const ruledOut = prior ? chainFails(prior.thread_id) : [];
    let structured: ReportFinding[] | undefined;
    try { structured = findings?.findings ? JSON.parse(findings.findings) as ReportFinding[] : undefined; } catch { structured = undefined; }
    const { prompt, reviewerBrief } = workerBrief({
      title: params.title, chiefThreadId: chief.thread_id, params, wave, waveTotal, waveNext, waveIndependent, designWave, implementsDesign,
      contracts, planContextLine, kind, verifyCommand, branch, issueUrl, prUrl, prior, findings, structured, ruledOut, specSources,
    });
    const thread = await managedSpawn.launch(prepared, {
      projectId,
      environment: prior
        ? { type: "reuse", environmentId: priorLive!.environmentId! }
        : {
          type: "host",
          hostId: hostId as string,
          workspace: {
            type: "managed-worktree",
            baseBranch: branch ? { kind: "named" as const, name: branch } : { kind: "default" as const },
          },
        },
      title: params.title, prompt,
    }, {
      role: "worker", chiefThreadId: chief.thread_id, brief: reviewerBrief,
      branch, issueUrl, prUrl, planThreadId, planWave: wave, unplannedReason, replacesThreadId: prior?.thread_id ?? null,
      kind: kind === "worker" ? null : kind, plannerOn, verifyCommand,
    });
    if (prior) {
      const now = Date.now();
      store.batch(() => {
        store.completeSuperseded(prior.thread_id, now);
        ledger.repoint(prior.thread_id, thread.id, now);
      });
    }
    return { threadId: thread.id, title: params.title, projectId };
  }

  const stallCapNote = ` Stall clock not reset: ${MAX_STALL_RESETS} nudges since the last report; the hard stall alert keeps its schedule.`;

  async function continueThread(threadId: string, instruction: string, callerChiefThreadId?: string | null) {
    const row = store.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker, planner, reviewer, or advisor ${threadId}.`);
    const callerChief = callerChiefThreadId ? store.get(callerChiefThreadId) : undefined;
    const effectiveChiefId = (callerChief && callerChief.role === "chief")
      ? callerChief.thread_id
      : (row.chief_thread_id ?? undefined);
    const handoff = `Hand it to a fresh worker instead: ${replacesCall(row)} keeps the same worktree, branch, and pull request.`;
    if (row.role === "worker" && (row.state === "ready" || row.state === "complete")) {
      throw new Error(`Worker ${threadId} already reported ${row.state}. chief_continue never reuses a finished worker for more work — deferred acceptance criteria, a rebase or restack, or a new task. ${handoff}`);
    }
    if (row.role !== "worker" && (row.state === "ready" || row.state === "complete")) {
      throw new Error(`${threadId} already reported; chief_continue is only a nudge to a thread still working. ${rerouteSteps(row)}`);
    }
    if (instruction.trim().length > MAX_NUDGE_LENGTH) {
      throw new Error(`chief_continue is a short nudge of at most ${MAX_NUDGE_LENGTH} characters to a thread that is still working. ${row.role === "worker" ? handoff : rerouteSteps(row)}`);
    }
    // Planners, reviewers, advisors, and researchers all stay out of the files; only a worker
    // edits. The instruction leads so the child reads what it says first, ahead of
    // the read-only reminder. steer-if-active steers a running turn instead of
    // waiting in BB's queue, and starts a turn when the thread is idle.
    const reminder = CONTINUE_REMINDERS[row.role] ?? null;
    const text = reminder ? `${instruction}\n\n${reminder}` : instruction;
    await bb.sdk.threads.send({
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text, mentions: [] }],
      senderThreadId: effectiveChiefId,
    });
    const now = Date.now();
    // The store decides from the stored counter inside one synchronous transaction, not the pre-send snapshot:
    // overlapping continues and an interleaved report (which zeroes it) must each see the current value.
    const capped = store.markContinued(threadId, now, MAX_STALL_RESETS);
    return capped;
  }

  const insertPlanLog = db.prepare<[string, string, number | null, string, string, string, string, string]>(
    `INSERT INTO plan_log (plan_thread_id, author_thread_id, wave, kind, text, scope, basis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  function appendPlanLog(row: ManagedRow, entries: z.infer<typeof logParams>["entries"] & {}) {
    const at = new Date().toISOString();
    for (const entry of entries) {
      insertPlanLog.run(row.plan_thread_id!, row.thread_id, row.plan_wave, entry.kind, entry.text, entry.scope, entry.basis, at);
    }
  }

  /** chief_log: append the caller's entries, then return unread peer entries and every wave's current owner and state. */
  function planLog(row: ManagedRow, entries: z.infer<typeof logParams>["entries"]): string {
    const planThreadId = row.plan_thread_id!;
    const unread = db.prepare(`SELECT * FROM plan_log WHERE plan_thread_id=? AND id>? AND author_thread_id<>? ORDER BY id LIMIT ?`)
      .all(planThreadId, row.log_read_id ?? 0, row.thread_id, MAX_LOG_READ + 1) as {
        id: number; author_thread_id: string; wave: number | null; kind: string; text: string; scope: string; basis: string;
      }[];
    const shown = unread.slice(0, MAX_LOG_READ);
    const write = () => {
      if (entries?.length) appendPlanLog(row, entries);
      // Only the cursor moves: never state, report_seq or the alert outbox.
      if (shown.length) store.markLogRead(row.thread_id, shown.at(-1)!.id);
    };
    // Appended entries alone touch no managed row, so only a moved cursor reloads.
    if (shown.length) store.batch(write);
    else db.transaction(write)();
    const more = unread.length > MAX_LOG_READ
      ? (db.prepare(`SELECT COUNT(*) AS n FROM plan_log WHERE plan_thread_id=? AND id>? AND author_thread_id<>?`)
        .get(planThreadId, shown.at(-1)!.id, row.thread_id) as { n: number }).n
      : 0;
    const waves = planWavesFor(planThreadId);
    return [
      entries?.length ? `Appended ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.` : null,
      "## Unread peer entries",
      ...(shown.length
        ? shown.map((entry) => `- #${entry.id} ${entry.kind} wave ${entry.wave ?? "?"} @thread:${entry.author_thread_id} [${entry.scope}] ${entry.text} (basis: ${entry.basis})`)
        : ["- none"]),
      ...(more ? [`${more} more unread: call chief_log again.`] : []),
      "", "## Waves",
      ...waves.map((_, index) => {
        const current = waveWorkers(planThreadId, index + 1).at(-1);
        if (!current) return `- wave ${index + 1}: not delegated`;
        const last = (current.result ?? current.status ?? "").split("\n").find((line) => line.trim()) ?? "";
        return `- wave ${index + 1}: @thread:${current.thread_id} ${current.state}${last ? ` | ${clip(last.trim(), 160)}` : ""}`;
      }),
    ].filter((line) => line !== null).join("\n");
  }

  /** The next call once a delegated test wave is waived: its latest worker still owns the branch. */
  function waivedLine(owner: ManagedRow): string {
    return `Tests on wave ${owner.plan_wave} waived. ${owner.thread_id} still owns the branch: review it — chief_review (workerThreadId: ${owner.thread_id}) — or complete it without one — chief_complete (threadId: ${owner.thread_id}, skipReview: your reason).`;
  }

  /** Why a worker may not start a review now, or null. The review of a plan runs once, after every wave is ready. */
  function reviewRefusal(worker: ManagedRow): string | null {
    const block = progress.reviewBlock(worker);
    if (!block) return null;
    switch (block.kind) {
      case "design": return DESIGN_REVIEW_REFUSAL;
      case "superseded":
        return `${worker.thread_id} is superseded by ${block.latest.thread_id}. The plan's one review starts from the latest workers: chief_review (workerThreadId: ${block.latest.thread_id}) once every wave is ready.`;
      case "restack":
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Wave ${block.next} is stacked on it and still builds on the old head: restack it first — chief_delegate (replaces: ${block.successor.thread_id}${block.waves[block.next - 1]!.test ? ", kind: tester" : ""}).`;
      case "restacked":
        return `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Wave ${block.next} was already restacked as ${block.successor.thread_id}; start the plan's one review from the latest chain-tip worker once every wave is ready.`;
      case "betweenWaves":
        return block.waves[block.next - 1]!.test
          ? `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Delegate test wave ${block.next}: ${block.waves[block.next - 1]!.path} — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, replaces: ${worker.thread_id}, kind: tester). To go without tests, record why: chief_skip_tests (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, reason).`
          : `Wave ${worker.plan_wave} of ${block.waves.length}: no review runs between waves. Delegate wave ${block.next}: ${block.waves[block.next - 1]!.path} — chief_delegate (planThreadId: ${worker.plan_thread_id}, wave: ${block.next}, replaces: ${worker.thread_id}).`;
      case "pending":
        return `One review covers the whole plan once every wave is ready; wave(s) ${block.pending.join(", ")} of ${block.waves.length} are not ready yet. Wait for their ready reports (delegate any wave not delegated yet), then start the review.`;
    }
  }

  /** A ready chain-tip worker's waiting line while other waves of its plan are not ready yet, else null. */
  function waveWaitLine(row: ManagedRow): string | null {
    const waiting = progress.waitingOn(row);
    return waiting
      ? `Wave ${row.plan_wave} of ${waiting.waves.length} is ready; the one review of the whole plan waits until wave(s) ${waiting.pending.join(", ")} are ready. Do not review yet.`
      : null;
  }

  /** A ready worker's exact next call: the wave that builds on it (no review runs between
   * waves; a design-only wave first asks the owner to approve its artboards), nothing while
   * other waves are still unready (waveWaitLine), the one review of the whole plan once every
   * wave is ready (named once, on the plan's first reviewable tip, unless forAlert) — or, with no
   * plan link at all, its own review call. */
  function workerReadyNextStep(row: ManagedRow, forAlert = false): string | null {
    const step = progress.readyStep(row, forAlert);
    if (!step) return null;
    switch (step.kind) {
      case "designNext":
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready: its artboards need the owner's approval before any code. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval, first record it: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words); then delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}); it runs as a worker, so name the approved artboards in its mission. On requested changes, delegate a fresh designer with chief_delegate (replaces: ${row.thread_id}) and the owner's feedback as its mission; it stays on wave ${row.plan_wave}. Never chief_review a design wave, and do not review between waves.`;
      case "designDone":
        return `Design wave ${row.plan_wave} of ${step.waves.length} is ready and nothing builds on it: its artboards need the owner's approval. Show the user the artboard names and screenshots from its report in this thread and ask for explicit approval. On approval: chief_owner_approval (workerThreadId: ${row.thread_id}, approval: the user's exact words), then chief_complete (threadId: ${row.thread_id}). Never chief_review it.`;
      case "restack":
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready after its fix. Wave ${step.next} is stacked on it and still builds on the old head: once this worker is idle, restack it — chief_delegate (replaces: ${step.successor.thread_id}${step.waves[step.next - 1]!.test ? ", kind: tester" : ""}), with a mission to rebase ${step.successor.branch ?? `wave ${step.next}'s branch`} onto ${row.branch ?? "this branch"} and fix what the rebase breaks; the review's findings are attached automatically. Do not review between waves.`;
      case "nextWave":
        if (step.waves[step.next - 1]!.test) {
          return `Wave ${row.plan_wave} of ${step.waves.length} is ready. Once it is idle, delegate test wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}, kind: tester). To go without tests, record why: chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, reason). Do not review between waves.`;
        }
        return `Wave ${row.plan_wave} of ${step.waves.length} is ready. Once it is idle, delegate wave ${step.next}: ${step.waves[step.next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${step.next}, replaces: ${row.thread_id}). Do not review between waves.`;
      case "retest":
        return `A worker changed code on test wave ${row.plan_wave} after the tests ran: rerun them — chief_delegate (replaces: ${row.thread_id}, kind: tester) — then review. If you judge a rerun unnecessary, waive it with chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, reason) or start the review: chief_review (workerThreadId: ${row.thread_id}).`;
      case "unplanned":
        return `${row.kind === "tester" ? "" : `Workers never test: delegate a tester on this branch first — chief_delegate (replaces: ${row.thread_id}, kind: tester) — or, to go without, pass testsSkipped (your reason) when you complete it. `}Start its review now: chief_review (workerThreadId: ${row.thread_id}), and complete the work on the reviewer's approve — or, if you judge a review unnecessary after reading its report and recorded commands, complete it without one: chief_complete (threadId: ${row.thread_id}, skipReview: your reason).`;
      case "review": {
        const branches = step.targets.map((target) => `${target.thread_id}${target.branch ? ` (${target.branch})` : ""}`).join(", ");
        return `${step.waves.length === 1 ? "The plan's only wave is" : `All ${step.waves.length} waves are`} ready. Start the one review of the whole plan now: chief_review (workerThreadId: ${step.namer.thread_id}). It covers every branch (${branches}). Complete each worker on that reviewer's approve — or, if you judge a review unnecessary, complete each of them without one: chief_complete (threadId: <each>, skipReview: your reason).`;
      }
    }
  }

  /** The plan advisors of planner P, oldest first: the one in flight, the decider (first advice wins) and the newest abandoned attempt. */
  function planAdvisors(plannerId: string) {
    const all = store.all().filter((r) => r.role === "advisor" && r.plan_thread_id === plannerId)
      .sort((a, b) => a.created_at - b.created_at);
    const inFlight = all.find((r) => r.advised_at == null && BUSY_STATUSES.has(r.state));
    const advised = all.filter((r) => r.advised_at != null);
    const decider = advised.length ? advised.reduce((a, b) => (b.advised_at! < a.advised_at! ? b : a)) : undefined;
    const abandoned = all.filter((r) => r.advised_at == null && r !== inFlight).at(-1);
    return { inFlight, decider, abandoned };
  }

  /** The planners revising planner P, newest first: one still working, and the one whose plan is in. */
  function revisionsOf(plannerId: string) {
    const all = store.all().filter((r) => r.role === "planner" && r.replaces_thread_id === plannerId).reverse();
    return {
      all,
      busy: all.find((r) => BUSY_STATUSES.has(r.state)),
      ready: all.find((r) => (r.state === "ready" || r.state === "complete") && !!r.plan_waves),
    };
  }

  /** Why a planner's waves may not be forge-initialised or delegated yet, naming the one next call; null when they may. */
  function planReviewRefusal(planner: ManagedRow): string | null {
    const P = planner.thread_id;
    if (planner.plan_review === "required") {
      const { inFlight, abandoned } = planAdvisors(P);
      if (inFlight) return `Plan ${P} is in its one advisor review (${inFlight.thread_id}): wait for ${inFlight.thread_id}'s report before chief_forge_init or chief_delegate.`;
      const waves = planWavesFor(P).filter((wave) => !wave.test).length;
      const why = waves > 1 ? `Plan ${P} has ${waves} implementation waves` : `Plan ${P} is marked complex`;
      const ended = abandoned ? `Advisor ${abandoned.thread_id} ended without advice (state ${abandoned.state}). ` : "";
      return `${ended}${why}: get its one advisor review first — chief_consult (planThreadId: ${P}, title, mission: review this plan before delegation). Do not chief_forge_init or chief_delegate it yet.`;
    }
    if (planner.plan_review !== "changes") return null;
    const revisions = revisionsOf(P);
    if (planner.state === "complete" && revisions.ready) return `Plan ${P} was revised by ${revisions.ready.thread_id}: delegate ${revisions.ready.thread_id}'s waves instead.`;
    if (revisions.busy) return `Plan ${P} is being revised by ${revisions.busy.thread_id}: wait for ${revisions.busy.thread_id}'s ready alert, then delegate ${revisions.busy.thread_id}'s waves.`;
    return `The advisor requested changes to plan ${P}: chief_plan (revises: ${P}, title, mission: revise per the advisor) — the plugin attaches the plan files and the advice; delegate the revision's waves when its ready alert arrives; it gets no second review.`;
  }

  /** A plan advisor's line: only the deciding advisor renders one, from its planner's review outcome. */
  function planAdvisorAction(row: ManagedRow, forAlert: boolean): string | null {
    const planner = store.get(row.plan_thread_id!);
    if (!planner || planAdvisors(planner.thread_id).decider?.thread_id !== row.thread_id) return null;
    if (planner.plan_review === "approved") {
      const next = nextAction(planner, forAlert);
      return next ? `The advisor approves the plan. ${next}` : null;
    }
    if (planner.plan_review !== "changes") return null;
    const line = planReviewRefusal(planner);
    if (!line) return null;
    return row.last_report_state === "blocked"
      ? `Plan advisor blocked: ${clip(row.blocker ?? "", 200)}. That was the plan's one review: escalate to the user if it names a product decision, then ${line}`
      : line;
  }

  /** A row's single pending call, reused identically in report()'s alert and
   * chief_roster's Pending block so the two surfaces never disagree. Purely a
   * function of already-persisted row state — no new columns, no new tracking. */
  function nextAction(row: ManagedRow, forAlert = false): string | null {
    if (row.role === "advisor" && row.plan_thread_id) return planAdvisorAction(row, forAlert);
    if (row.role === "planner" && row.replaces_thread_id && row.state === "blocked") {
      return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user, then chief_plan (revises: ${row.replaces_thread_id}) with the decision in context; it gets no review.`;
    }
    if (row.state === "blocked" && row.role === "worker") {
      const testWave = isTestWave(row) ? planWavesFor(row.plan_thread_id)[row.plan_wave! - 1]! : undefined;
      if (testWave?.testsSkipped) return waivedLine(row);
      if (row.kind === "tester") {
        return `Tests failed: ${clip(row.blocker ?? "", 200)}. Delegate a fresh worker to fix the product code: chief_delegate (replaces: ${row.thread_id}, kind: worker) with the failures as its mission; its ready alert then asks for a tester. ${testWave
          ? `If you judge the failures acceptable, waive them: chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave: ${row.plan_wave}, reason).`
          : "If you judge the failures acceptable, complete it with testsSkipped (your reason)."}`;
      }
    }
    if (row.state === "blocked") return `Blocked: ${clip(row.blocker ?? "", 200)} — decide or escalate to the user.`;
    if (row.state !== "ready") return null;
    if (row.role === "planner") {
      if (!row.plan_waves) return null;
      const refusal = planReviewRefusal(row);
      if (refusal) return refusal;
      const waves = planWavesFor(row.thread_id);
      const { heads, undelegated } = schedule.undelegatedHeads(row.thread_id, waves);
      if (!undelegated.length) return null;
      if (heads.length === 1) {
        return `Delegate wave 1 now: run chief_forge_init (planThreadId: ${row.thread_id}, wave: 1), then chief_delegate (planThreadId: ${row.thread_id}, wave: 1). The plugin supplies its plan file; do not read the plan. Escalate to the user only for a genuine product or scope open question the planner named.`;
      }
      return `Delegate wave${undelegated.length > 1 ? "s" : ""} ${undelegated.join(", ")} now, in parallel — for each wave run chief_forge_init (planThreadId: ${row.thread_id}, wave: N), then chief_delegate (planThreadId: ${row.thread_id}, wave: N), all in this turn. Each independent wave gets its own task title and so its own branch and PR from the default base (chief_forge_init without base); do not stack them. The plugin supplies each plan file; do not read the plans. Escalate to the user only for a genuine product or scope open question the planner named.`;
    }
    if (row.role === "worker") {
      // A reviewer that still covers this worker's latest report — either busy
      // (a review is actually in flight) or already reported on it — means its own
      // recommendation (below) covers this work now, so the worker itself must not
      // also ask for a review. The tie is report_seq equality, not updated_at: two
      // reports in the same millisecond are indistinguishable by timestamp, and a
      // reviewer that later completes (state moves to complete) must still count.
      // A re-pointed stale reviewer (delegate's `replaces:`) has its snapshot reset
      // to null, so it no longer matches and this still recommends chief_review.
      if (ledger.isCurrent(row)) return null;
      return workerReadyNextStep(row, forAlert);
    }
    if (row.role === "advisor") {
      if (row.worker_thread_id && ledger.rung(ledger.taskRejections(row.worker_thread_id).streak) === "stop") {
        return `The advisor changed nothing. The reviewer has now requested changes ${STOP_AFTER_REJECTIONS} times in a row: start no new worker, and escalate to the user with both positions, this advice, and your recommendation.`;
      }
      const advised = row.worker_thread_id ? store.get(row.worker_thread_id) : undefined;
      return `The advisor changed nothing. Decide the next step yourself: hand its advice to a fresh worker with ${advised ? replacesCall(advised) : row.worker_thread_id ? `chief_delegate (replaces: ${row.worker_thread_id})` : "chief_delegate (through chief_plan first when planning is on)"} with the advice in its context, or escalate to the user if it names a genuine decision.`;
    }
    if (row.role !== "reviewer" || !row.verdict) return null;
    // Null: replaces: re-pointed a covered worker to a fresh one (that branch's findings were handed off), or every covered worker is complete.
    const round = progress.fixRound(row);
    if (!round) return null;
    const { open, plan, stacks, loose } = round;
    // A stacked chain's waves each build on the one before, so they are fixed one at a time, never in parallel.
    const wave = (target: ReviewTarget) => store.get(target.worker_thread_id)?.plan_wave;
    const workers = open.map((target) => target.worker_thread_id).join(", ");
    if (row.verdict === "approve") {
      if (plan) {
        return `The reviewer approves the whole plan. ${open.map((target) => `chief_complete (threadId: ${target.worker_thread_id})`).join("; ")}; each marks its pull request ready. Nits listed with an approve are optional: start no worker round for them alone.`;
      }
      const complete = row.worker_thread_id
        ? `chief_complete (threadId: ${row.worker_thread_id}); it marks the pull request ready`
        : `chief_complete (threadId: ${row.thread_id}), then mark the pull request ready yourself (no worker owns it)`;
      return `The reviewer approves. ${complete}. Nits listed with an approve are optional: start no worker round for them alone.`;
    }
    const flagged = row.regression ? " The reviewer reports this change introduced a new problem; make the fix's brief name it." : "";
    // A tester's branch: a product fix goes to a worker, a test fix to a tester; replacing it needs the kind.
    const tested = (id: string) => { const target = store.get(id); return !!target && (target.kind === "tester" || isTestWave(target)); };
    const handoff = (id: string) => tested(id)
      ? `chief_delegate (replaces: ${id}, kind: worker) for product-code findings or chief_delegate (replaces: ${id}, kind: tester) for test-only findings`
      : `chief_delegate (replaces: ${id})`;
    const testerIds = open.map((target) => target.worker_thread_id).filter(tested);
    const mixed = testerIds.length
      ? ` On ${testerIds.join(", ")} name the kind: kind: worker for product-code findings, kind: tester for test-only findings. Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests.`
      : "";
    const rung = ledger.rung(row.reject_streak);
    if (rung === "stop") {
      return `The reviewer still requires changes after ${row.reject_streak} consecutive rounds, and the advisor's advice did not settle it. Stop: start no new worker. Escalate to the user with both positions (the reviewer's findings and the worker's), the consult's advice, and your recommendation; only the user can authorize another round.${flagged}`;
    }
    if (rung === "consult") {
      if (plan) {
        return `The reviewer still requires changes after ${row.reject_streak} consecutive rounds. Call chief_consult (workerThreadId: ${open[0]!.worker_thread_id}) now, before any further delegation, with every branch of the review (${workers}) in its context — one consult unlocks the fix for each. Then hand its advice to ${stacks.length
          ? `fresh workers with chief_delegate (replaces: …): on the stacked waves ${stacks.map((stack) => stack.map(wave).join(" → ")).join("; ")} one at a time in wave order, the earliest wave the findings name first, then each later wave restacked on it as its ready report directs; any other branch the findings name in this turn. Run exactly one more review once every wave is ready.`
          : "one fresh worker per branch the findings name with chief_delegate (replaces: …), all in this turn, and run exactly one more review."}${mixed} If that review still requires changes, stop and escalate to the user.${flagged}`;
      }
      return `The reviewer still requires changes after ${row.reject_streak} consecutive rounds. Call chief_consult${row.worker_thread_id ? ` (workerThreadId: ${row.worker_thread_id})` : " with this branch and review in its context"} now, before any further delegation — required even when every finding names file:line and a concrete fix. Then hand its advice to one fresh worker with ${row.worker_thread_id ? handoff(row.worker_thread_id) : `chief_delegate (branch: ${row.branch})`} and run exactly one more review.${row.worker_thread_id && tested(row.worker_thread_id) ? " Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests." : ""} If that review still requires changes, stop and escalate to the user.${flagged}`;
    }
    if (plan && stacks.length) {
      return `The reviewer requires changes.${flagged} ${stacks.map((stack) => `Waves ${stack.map(wave).join(" → ")} are stacked, each on the one before: fix them in wave order, never in parallel. Delegate the earliest of them the findings name now with chief_delegate (replaces: its worker) — ${stack.map((target) => `wave ${wave(target)}: ${target.worker_thread_id}`).join(", ")} — then restack each later wave on it as each ready report directs, even one the findings do not name.`).join(" ")}${loose.length ? ` Hand the fixes on the other branches the findings name to fresh workers in this turn: ${loose.map((target) => handoff(target.worker_thread_id)).join(" / ")}.` : ""}${mixed} Their findings are attached automatically, and the next review covers every branch again once every wave is ready. Escalate if the disagreement is a genuine decision.`;
    }
    if (plan) {
      return `The reviewer requires changes.${flagged} Hand the fixes to fresh workers in this turn, one per branch the findings name: ${open.map((target) => handoff(target.worker_thread_id)).join(" / ")}; their findings are attached automatically.${mixed} Delegate all of them before any reports: the next review covers every branch again. Escalate if the disagreement is a genuine decision.`;
    }
    return row.worker_thread_id
      ? `The reviewer requires changes.${flagged} Hand the fix to a fresh worker with ${handoff(row.worker_thread_id)}; its findings are attached automatically.${tested(row.worker_thread_id) ? " Mixed findings on a tester's branch: a worker fixes the product code first; its ready alert then asks for a tester to fix and rerun the tests." : ""} Escalate if the disagreement is a genuine decision.`
      : `The reviewer requires changes, and no managed worker owns branch ${row.branch}.${flagged} Hand the fix to a fresh worker with chief_delegate (branch: ${row.branch}${row.pr_url ? `, prUrl: ${row.pr_url}` : ""}; through chief_plan first when planning is on) with the findings in its context, then chief_complete this review. Escalate if the disagreement is a genuine decision.`;
  }

  /** The one open/done test: the panel's unchecked items are exactly Pending's actions plus work
   * still in progress. A worker is open until complete; a planner, reviewer, or advisor only while
   * it runs or names a next action. */
  function isOpenItem(row: ManagedRow) {
    if (["complete", "archived", "deleted"].includes(row.state)) return false;
    return row.role === "worker" || BUSY_STATUSES.has(row.state) || nextAction(row) !== null;
  }

  /** Live status of a worker. When its row is already ready, waits up to REVIEW_IDLE_WAIT_MS
   * for its turn to end: the ready alert is sent from inside the worker's chief_report call,
   * so that turn is still ending when Chief acts on it. A worker that has not reported is not waited on. */
  async function waitIdleAfterReport(worker: ManagedRow) {
    let live = await bb.sdk.threads.get({ threadId: worker.thread_id });
    // ponytail: polls; defer the alert to thread.idle if a minute is not enough.
    for (const deadline = Date.now() + REVIEW_IDLE_WAIT_MS; worker.state === "ready" && BUSY_STATUSES.has(live.status) && Date.now() < deadline;) {
      await researchSleep(REVIEW_IDLE_POLL_MS);
      live = await bb.sdk.threads.get({ threadId: worker.thread_id });
    }
    return live;
  }

  /** Throws the busy-worker refusal, counting it as a timing race for bb chief stats. */
  function busyRejection(worker: ManagedRow, status: string, before: string): never {
    store.countBusyRejection(worker.thread_id);
    throw new Error(`Worker ${worker.thread_id} is ${status}; wait until it is idle before ${before}.`);
  }

  const { startReview, startBranchReview } = createReviewStart<ManagedRow>({
    db, store, ledger, managedSpawn, requireChiefCaller, reviewRefusal, reviewTargetsFor, planWavesFor, controlsThread, terminal,
    busyStatuses: BUSY_STATUSES, waitIdleAfterReport, busyRejection, prHead, projectPath, projectHostId, defaultHostId, environmentHostId,
    recordedCommands, recordedLines, verdictPreview, clip, clipMiddle, writeReviewContext, impactSlice,
    reviewedAncestry: reviewedAncestryOf,
  });

  /** Why the project's checkout path cannot be used here, or null when it is on the server's primary host.
   * The path names a checkout on the source's own host; only the server's primary host may read it. Never throws. */
  async function checkoutHostSkip(projectId: string): Promise<string | null> {
    let lookupError: unknown = "no source host recorded";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const project = await bb.sdk.projects.get({ projectId });
        const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
        if (!source?.hostId) break;
        return source.hostId === (await bb.sdk.system.config()).primaryHostId ? null : "the project checkout is on a remote host, not the plugin server";
      } catch (error) { lookupError = error; }
    }
    return `could not confirm which host holds the project checkout (${clip(String(lookupError), 200)})`;
  }

  /** bb waits 5 min, then retries a failed teardown after 1, 2, 4 and 8 min with hooks of up to 15 min each. */
  const TEARDOWN_LIMIT_MS = 60 * 60_000;
  const MISSING = /not found|404/i;
  const CLEANUP_ATTEMPTS = 3;
  /** How long a job waits on a busy root or live descendants before it gives up on that thread. */
  const CLEANUP_WAIT_MS = 60 * 60_000;
  /** bb's undo window after an archive: its worktree and storage are untouched until it passes. */
  const CLEANUP_GRACE_MS = 5 * 60_000;
  const CLEANUP_READ_MS = 15_000;
  const CLEANUP_CALL_MS = 30_000;
  type CleanupStep = "archive" | "teardown" | "branch" | "storage" | "done";
  interface CleanupJob {
    thread_id: string; chief_thread_id: string; project_id: string; environment_id: string | null; branch: string | null; step: CleanupStep;
    step_at: number; archived_at: number | null; attempts: number; last_error: string | null; outcome: string | null; created_at: number; updated_at: number;
  }
  /** Where a step's third failure lands: the safe outcome (nothing destructive follows a failed archive) and what the alert tells Chief. */
  const CLEANUP_FAILURE: Record<Exclude<CleanupStep, "done">, { next: "storage" | "done"; outcome: string; left: string }> = {
    archive: { next: "done", outcome: "kept: archive failed", left: "the thread, its branch and its storage are untouched" },
    teardown: { next: "storage", outcome: "branch kept: environment unreadable", left: "the bb/ branch (bb's worktree state is unknown)" },
    branch: { next: "storage", outcome: "branch kept: lookup or git failed", left: "the local bb/ branch" },
    storage: { next: "done", outcome: "storage kept", left: "the thread storage" },
  };

  /** Moves a job to its next step in one UPDATE, with the alert that goes with the move in the same transaction. Delivery is
   * not awaited: the outbox row is durable and retryAlerts re-sends it. */
  function cleanupMove(job: CleanupJob, step: CleanupStep, change: { outcome?: string; archivedAt?: number; environmentId?: string | null; branch?: string | null } = {}, alert?: { key: string; message: string }) {
    const key = db.transaction(() => {
      const now = Date.now();
      db.prepare(`UPDATE cleanup_jobs SET step=?, step_at=?, attempts=0, last_error=NULL, outcome=COALESCE(?, outcome), archived_at=COALESCE(?, archived_at),
        environment_id=COALESCE(?, environment_id), branch=COALESCE(?, branch), updated_at=? WHERE thread_id=?`).run(
        step, now, change.outcome ?? null, change.archivedAt ?? null, change.environmentId ?? null, change.branch ?? null, now, job.thread_id,
      );
      return alert ? writeAlert(store.get(job.thread_id)!, alert.key, alert.message) : null;
    })();
    if (key) void deliverAlert(key).catch((error) => bb.log.warn(`Cleanup alert ${key} will be retried: ${String(error)}`));
  }

  /** Counts a failed attempt; the third moves the job to the step's safe outcome and tells Chief, in one transaction. */
  function cleanupFail(job: CleanupJob, error: unknown) {
    const detail = clip(error instanceof Error ? error.message : String(error), 500);
    if (job.step === "done") return;
    if (job.attempts + 1 < CLEANUP_ATTEMPTS) {
      db.prepare(`UPDATE cleanup_jobs SET attempts=attempts+1, last_error=?, updated_at=? WHERE thread_id=?`).run(detail, Date.now(), job.thread_id);
      return;
    }
    const failure = CLEANUP_FAILURE[job.step];
    const recover = job.step === "archive" ? `bb thread archive ${job.thread_id}`
      : job.step === "teardown" ? `bb environment show ${job.environment_id ?? "<environment id>"}`
      : job.step === "branch" ? `git branch -D ${job.branch ?? "<branch>"} (only after confirming origin holds its commits)`
      : `bb storage clear-thread --thread ${job.thread_id} --yes${/plugin|method/i.test(detail) && /not found|unknown|not installed|disabled/i.test(detail) ? " (enable the storage-retention plugin first)" : ""}`;
    cleanupMove(job, failure.next, { outcome: failure.outcome }, {
      key: `cleanup-${job.step}-failed:alert`,
      message: `Cleanup of ${job.thread_id} failed at the ${job.step} step after ${CLEANUP_ATTEMPTS} attempts: ${clip(detail, 200)}. Left in place: ${failure.left}. Recover by hand: ${recover}.`,
    });
  }

  /** The thread as bb has it now, or null when it is gone or deleted. Any other read error throws. */
  async function cleanupRead(threadId: string) {
    try {
      const thread = await bounded(() => bb.sdk.threads.get({ threadId }), CLEANUP_READ_MS);
      return thread.deletedAt === null ? thread : null;
    } catch (error) {
      if (MISSING.test(String(error))) return null;
      throw error;
    }
  }

  /** One supervisor-tick pass over the post-approval cleanup: enqueue the threads of positively approved, completed tasks, then
   * move each open job one step. Archive comes first and only when bb's recursive archive cannot reach any other live thread; the
   * branch and the storage follow bb's own teardown and grace. Every failure is bounded: three attempts, then one alert and a
   * safe outcome. One job's error never skips another. With the setting off nothing runs and jobs are kept as they are. */
  async function observeCleanup() {
    if (!cleanupActive) return;
    let eligible = new Set<string>();
    try {
      eligible = cleanupEligible(store.all(), (id) => ledger.targets(id).map((target) => target.worker_thread_id));
      const insert = db.prepare(`INSERT OR IGNORE INTO cleanup_jobs (thread_id, chief_thread_id, project_id, step, step_at, created_at, updated_at) VALUES (?, ?, ?, 'archive', ?, ?, ?)`);
      const now = Date.now();
      for (const id of eligible) {
        const row = store.get(id)!;
        insert.run(id, row.chief_thread_id, row.project_id, now, now, now);
      }
    } catch (error) {
      bb.log.error(`Cleanup could not enqueue approved threads this tick: ${String(error)}`);
    }
    try {
      const jobs = db.prepare(`SELECT * FROM cleanup_jobs WHERE step <> 'done' ORDER BY created_at ASC, rowid ASC`).all() as CleanupJob[];
      for (const job of jobs) {
        try {
          await cleanupStep(job, eligible);
        } catch (error) {
          try { cleanupFail(job, error); }
          catch (inner) { bb.log.error(`Cleanup of ${job.thread_id} could not record a failure at the ${job.step} step (${String(error)}): ${String(inner)}`); }
        }
      }
    } catch (error) {
      bb.log.error(`Cleanup could not read its jobs this tick: ${String(error)}`);
    }
  }

  async function cleanupStep(job: CleanupJob, eligible: Set<string>) {
    const id = job.thread_id;
    const row = store.get(id);
    if (!row) return cleanupMove(job, "done", { outcome: "kept: no managed row" });
    const label = `${row.role} “${row.title}” (${id})`;
    const waited = Date.now() - job.step_at;
    const finish = (outcome: string, alert?: { key: string; message: string }) => cleanupMove(job, "done", { outcome }, alert);

    if (job.step === "archive") {
      const live = await cleanupRead(id);
      if (!live) return finish("deleted");
      if (live.pinnedAt !== null) return finish("kept: pinned");
      let archivedAt = live.archivedAt;
      let environmentId = live.environmentId ?? null;
      if (archivedAt === null) {
        if (BUSY_STATUSES.has(live.status)) return waited > CLEANUP_WAIT_MS ? finish("kept: in use") : undefined;
        // bb's archive is recursive over children, hidden forks and lifecycle dependents with no check of their own: archive only a thread whose closure is itself.
        const [summary, children, forks] = await Promise.all([
          bounded(() => bb.sdk.threads.childSummary({ threadId: id }), CLEANUP_READ_MS),
          bounded(() => bb.sdk.threads.list({ parentThreadId: id, includeHidden: true, limit: 100 }), CLEANUP_READ_MS),
          bounded(() => bb.sdk.threads.list({ sourceThreadId: id, includeHidden: true, limit: 100 }), CLEANUP_READ_MS),
        ]);
        const liveOthers = (page: typeof children) => page.length >= 100 || page.some((other) => other.id !== id && other.archivedAt === null && other.deletedAt === null);
        if (summary.unarchivedDescendantCount > 0 || liveOthers(children) || liveOthers(forks)) {
          if (waited <= CLEANUP_WAIT_MS) return;
          return finish("kept: live descendants", {
            key: "cleanup-scope-kept:alert",
            message: `Cleanup of ${label} did not archive it: other live threads would be archived with it (children, forks or dependents) and they stayed live for 60 minutes. Left in place: the thread, its branch and its storage. Archive it yourself when they are done: bb thread archive ${id}.`,
          });
        }
        const archived = await bounded(() => bb.sdk.threads.archive({ threadId: id }), CLEANUP_CALL_MS);
        const extra = archived.archivedThreadIds.filter((other) => other !== id);
        if (extra.length) {
          const key = enqueueAlert(row, "cleanup-scope-extra:alert", `Cleaning up ${label} archived ${extra.length} other thread(s) with it: ${extra.join(", ")}. Restore each with: ${extra.map((other) => `bb thread unarchive ${other}`).join("; ")}.`);
          void deliverAlert(key).catch((error) => bb.log.warn(`Cleanup alert ${key} will be retried: ${String(error)}`));
        }
        const after = await bounded(() => bb.sdk.threads.get({ threadId: id }), CLEANUP_READ_MS);
        if (after.archivedAt === null) throw new Error("the archive call returned but the thread is not archived");
        archivedAt = after.archivedAt;
        environmentId = after.environmentId ?? environmentId;
      }
      // Step-out: the thread's own bb/ branch, only when its worktree environment is read and its name is owned by this job's Chief and project.
      let branch: string | null = null;
      let unreadable: string | null = null;
      if (environmentId) {
        try {
          const environment = await bounded(() => bb.sdk.environments.get({ environmentId: environmentId! }), CLEANUP_READ_MS);
          const owns = (threadId: string) => { const owner = store.get(threadId); return eligible.has(threadId) && owner?.chief_thread_id === job.chief_thread_id && owner?.project_id === job.project_id; };
          branch = environment.isWorktree ? ownedBranch(environment.branchName, owns) : null;
        } catch (error) { unreadable = clip(String(error), 200); }
      }
      return cleanupMove(job, branch ? "teardown" : "storage", { archivedAt, environmentId, branch, outcome: unreadable ? "branch kept: environment unreadable" : undefined }, unreadable ? {
        key: "cleanup-branch-kept:alert",
        message: `Cleanup of ${label} archived it but could not read its environment ${environmentId} (${unreadable}), so its bb/ branch was not touched. Left in place: the branch. Inspect: bb environment show ${environmentId}.`,
      } : undefined);
    }

    // Every later step belongs to the archive generation it recorded: an unarchive, or an unarchive and a re-archive, ends the job.
    const generation = job.archived_at;
    if (generation === null) throw new Error("no archive time recorded for this job");
    if (job.step === "storage" && Date.now() < generation + CLEANUP_GRACE_MS) return;
    const live = await cleanupRead(id);
    if (!live) return finish("kept: thread deleted");
    if (live.archivedAt !== generation) return finish("kept: unarchived");

    if (job.step === "teardown") {
      let environment: Awaited<ReturnType<typeof bb.sdk.environments.get>> | null = null;
      try {
        environment = await bounded(() => bb.sdk.environments.get({ environmentId: job.environment_id! }), CLEANUP_READ_MS);
      } catch (error) {
        if (!MISSING.test(String(error))) throw error; // a read error is never proof that the environment is gone
      }
      if (!environment || environment.status === "destroyed" || environment.lifecycle.phase === "destroyed" || environment.hostLifecycle === "removed") return cleanupMove(job, "branch");
      const teardown = environment.lifecycle.teardown;
      const trouble = teardown?.message?.startsWith("Needs recovery:") ? teardown.message
        : environment.hostLifecycle === "cleanup-failed" && teardown?.status !== "running" ? `bb reports cleanup-failed${teardown?.message ? `: ${teardown.message}` : ""}` : null;
      const left = `Left in place: the bb/ branch ${job.branch} and the worktree. Inspect: bb environment show ${job.environment_id}.`;
      if (trouble) return cleanupMove(job, "storage", { outcome: "branch kept: teardown trouble" }, { key: "cleanup-teardown-trouble:alert", message: `Cleanup of ${label}: bb could not remove its worktree environment: ${clip(trouble, 300)}. ${left}` });
      if (Date.now() - generation <= TEARDOWN_LIMIT_MS) return;
      if (environment.lifecycle.phase === "active") return cleanupMove(job, "storage", { outcome: "branch kept: environment in use" });
      return cleanupMove(job, "storage", { outcome: "branch kept: teardown stuck" }, { key: "cleanup-teardown-stuck:alert", message: `Cleanup of ${label}: bb has not removed its worktree environment 60 minutes after the archive (${environment.lifecycle.phase}/${environment.hostLifecycle}). ${left}` });
    }

    if (job.step === "branch") {
      const [project, config] = await Promise.all([
        bounded(() => bb.sdk.projects.get({ projectId: job.project_id }), CLEANUP_READ_MS),
        bounded(() => bb.sdk.system.config(), CLEANUP_READ_MS),
      ]);
      const source = project.sources?.find((candidate) => candidate.isDefault) ?? project.sources?.[0];
      const kept = (reason: string, alert = false) => cleanupMove(job, "storage", { outcome: `branch kept: ${reason}` }, alert ? {
        key: "cleanup-branch-kept:alert",
        message: `Cleanup of ${label} kept its bb/ branch ${job.branch}: ${reason}. Left in place: the local branch. Delete it yourself with git branch -D ${job.branch} once you have confirmed origin holds its commits.`,
      } : undefined);
      if (!source?.hostId) return kept("no source host recorded for the project", true);
      if (!source.path) return kept("the project has no checkout path");
      if (source.hostId !== config.primaryHostId) return kept("the project checkout is on a remote host, not the plugin server");
      const result = await bounded(() => deleteSafeBranch({ cwd: source.path!, env: forgeEnv(), branch: job.branch!, deadlineMs: CLEANUP_CALL_MS }), CLEANUP_CALL_MS + 5_000);
      if ("error" in result) throw new Error(result.error);
      if ("kept" in result) return kept(result.kept, true);
      return cleanupMove(job, "storage", { outcome: "deleted" in result ? `branch deleted${result.note ? ` (${result.note})` : ""}` : "branch already gone" });
    }

    // storage
    const since = Number((db.prepare(`SELECT value FROM plugin_meta WHERE key='artifact_fallbacks_since'`).get() as { value: string } | undefined)?.value);
    const fallback = db.prepare(`SELECT 1 FROM artifact_fallbacks WHERE thread_id=?`).get(id);
    // A fallback leaves Chief's artifacts in this storage; before tracking began the history is unknown, so that fails closed too.
    if (fallback || !(row.created_at >= since)) {
      return finish("storage kept: evidence", {
        key: "cleanup-evidence-kept:alert",
        message: `Cleanup of ${label} kept its thread storage: ${fallback ? "Chief's artifacts for it were written there (the BB data dir was unknown)" : "it was created before Chief tracked that, so its artifacts may be there"}. Left in place: the storage. Clear it yourself once nothing there is needed: bb storage clear-thread --thread ${id} --yes.`,
      });
    }
    await bounded(() => bb.sdk.plugins.callRpc({ pluginId: "bb--storage-retention", method: "clearThread", input: { threadId: id }, outputSchema: z.object({ ok: z.literal(true) }) }), CLEANUP_CALL_MS);
    return finish("cleaned");
  }

  /** Whether the previous reviewed head is an ancestor of the pinned head, from the project checkout; never throws. */
  async function reviewedAncestryOf(row: ManagedRow, previousSha: string, head: PinnedHead, projectDir: string | null): Promise<{ ancestor: true } | { skipped: string }> {
    try {
      if (!projectDir) return { skipped: "no local checkout of the project on the plugin server" };
      const hostSkip = await checkoutHostSkip(row.project_id);
      if (hostSkip) return { skipped: hostSkip };
      return await reviewedAncestry({ cwd: projectDir, env: forgeEnv(), previousSha, head, deadlineMs: 20_000 });
    } catch (error) {
      return { skipped: clip(String(error), 200) };
    }
  }

  /** The impact slice of the commit under review, read from the project checkout with git only (no worktree is created). */
  async function impactSlice(row: ManagedRow, head: PinnedHead | null, projectDir: string | null, maxEntries: number): Promise<ImpactSlice> {
    // One 30 s deadline covers the host lookup, the branch resolution and the slice itself.
    const deadline = Date.now() + 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A finished slice is final: neither the deadline nor a later failure may replace it with a skip.
    let completed: ImpactSlice | undefined;
    let publish: (slice: ImpactSlice) => void = () => undefined;
    const ready = new Promise<ImpactSlice>((resolve) => { publish = (slice) => { completed = slice; resolve(slice); }; });
    const expired = new Promise<ImpactSlice>((resolve) => { timer = setTimeout(() => resolve(completed ?? { skipped: "deadline (30 s) passed" }), 30_000); });
    const work = async (): Promise<ImpactSlice> => {
      if (!projectDir) return { skipped: "no local checkout of the project on the plugin server" };
      const hostSkip = await checkoutHostSkip(row.project_id);
      if (hostSkip) return { skipped: hostSkip };
      const options = () => ({ cwd: projectDir, env: forgeEnv(), maxEntries, deadlineMs: deadline - Date.now(), onReady: publish });
      if (head) return await computeImpactSlice({ ...options(), sha: head.sha, baseRef: `origin/${head.base}`, fetchRef: head.branch });
      if (!row.branch) return { skipped: "the worker has no branch and no pinned head" };
      const run = gitWithin(projectDir, forgeEnv(), deadline);
      const git = (args: string[]) => run(args).then((out) => out.trim() || null, (error: Error) => { if (error.message === "deadline") throw error; return null; });
      const sha = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${row.branch}^{commit}`])
        ?? await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${row.branch}^{commit}`]);
      if (!sha) return { skipped: `branch ${row.branch} not found locally` };
      const baseRef = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      if (!baseRef) return { skipped: "origin/HEAD not set" };
      return await computeImpactSlice({ ...options(), sha, baseRef, fetchRef: row.branch });
    };
    try {
      return await Promise.race([work(), ready, expired]);
    } catch (error) {
      return completed ?? { skipped: clip(String(error), 200) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Which path a worker review took, for chief_review's reply. */
  function reviewPathNote(workerThreadId: string, pinnedSha?: string | null, covers?: string[]) {
    if (covers && covers.length > 1) return `One review covers the whole plan: ${covers.join(", ")}, each pull request pinned to its own head commit where the forge answered. Complete each worker only on its approve.`;
    if (pinnedSha) return `It reviews the pull request pinned to head commit ${pinnedSha} in its own worktree.`;
    return store.get(workerThreadId)?.pr_url
      ? "The pull request head could not be read, so it reviews the worker's own environment and its verdict is not bound to a commit: chief_complete will need a fresh review once the forge answers, or an override."
      : "It reviews the worker's own environment (no pull request).";
  }

  /** Why a worker may not complete yet, or null when its newest review covers what it would ship.
   * With a pull request the verdict must be an approve given for the PR head the forge reports now;
   * without one it must be an approve for the worker's current report. A design-wave worker needs the owner's recorded approval instead.
   * Unreadable forge state refuses: fail closed. */
  async function completionRefusal(row: ManagedRow): Promise<string | null> {
    if (isDesignWave(row)) {
      return row.owner_approval ? null : `${row.thread_id} is design-only work, which only the owner approves: show the user its artboards and record their decision with chief_owner_approval (workerThreadId: ${row.thread_id}), or pass override with a reason to complete anyway.`;
    }
    const newest = ledger.newestVerdict(row);
    const next = `Start a fresh review with chief_review (workerThreadId: ${row.thread_id}${row.plan_thread_id ? "; on a plan it covers every branch, once every wave is ready" : ""}), complete it without a review with skipReview (your reason), or pass override with a reason to complete anyway.`;
    if (!newest) return `${row.thread_id} has no review verdict. ${next}`;
    if (newest.verdict !== "approve") return `The newest review of ${row.thread_id} is ${newest.verdict}, not an approve. ${next}`;
    if (row.pr_url) {
      const head = await prHead(row.pr_url, await projectPath(row.project_id));
      if (!head) return `Cannot read the current head of ${row.pr_url} from the forge, so the approve cannot be matched to it. Retry, or pass override with a reason to complete anyway.`;
      if (newest.head_sha?.toLowerCase() !== head.sha) {
        return `The approve covers ${newest.head_sha ?? "no recorded commit"} but ${row.pr_url} is now at ${head.sha}. ${next}`;
      }
      return null;
    }
    if (newest.worker_thread_id !== row.thread_id || newest.reviewed_report_seq !== row.report_seq) {
      return `The newest approve does not cover ${row.thread_id}'s current report (report ${row.report_seq}). ${next}`;
    }
    return null;
  }

  /** override is the one bypass of a worker's review requirement; its reason is recorded in the stored result.
   * skipReview completes a worker without a review by Chief's judgment: refused only for invalid state, never cleaned up. */
  async function markComplete(threadId: string, result?: string, override?: string, skipReview?: string, testsSkipped?: string) {
    const row = store.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed worker or reviewer ${threadId}.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (BUSY_STATUSES.has(live.status)) throw new Error(`Cannot complete ${threadId} while it is ${live.status}.`);
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot complete ${threadId} because it is not a live thread.`);
    let overrideNote: string | null = null;
    let overrideReason: string | null = null;
    let approved = false;
    let reviewSkipped: string | null = null;
    let testsSkippedReason: string | null = null;
    if (testsSkipped !== undefined) {
      const reason = overrideSchema.safeParse(testsSkipped);
      if (!reason.success || !reason.data) throw new Error(`Refusing to complete ${threadId}: testsSkipped needs a non-empty reason of at most the allowed length.`);
      if (row.role !== "worker") throw new Error(`Refusing to complete ${threadId}: testsSkipped is only for a worker.`);
      if (planWavesFor(row.plan_thread_id).some((wave) => wave.test)) {
        throw new Error(`Refusing to complete ${threadId}: its plan has a test wave; go without it with chief_skip_tests (planThreadId: ${row.plan_thread_id}, wave, reason), not testsSkipped.`);
      }
      testsSkippedReason = reason.data;
    } else if (row.role === "worker" && !row.plan_thread_id && !ledger.taskChain(threadId).some((id) => store.get(id)?.kind === "tester")) {
      throw new Error(`No tester ran on this work: delegate one first — chief_delegate (replaces: ${threadId}, kind: tester) — or pass testsSkipped: your reason.`);
    }
    if (skipReview !== undefined) {
      const refuse = (why: string): never => { throw new Error(`Refusing to skip the review of ${threadId}: ${why}`); };
      const reason = overrideSchema.safeParse(skipReview);
      if (!reason.success || !reason.data) refuse("skipReview needs a non-empty reason of at most the allowed length.");
      if (row.role !== "worker") refuse("only a worker's review can be skipped.");
      if (override !== undefined) refuse("pass skipReview or override, not both.");
      if (isDesignWave(row)) refuse("design-only work is approved by the owner only: record it with chief_owner_approval, or pass override.");
      // A waived test wave is Chief's recorded decision to accept that branch, so its blocked report also counts.
      const waived = row.last_report_state === "blocked" && isTestWave(row) && !!planWavesFor(row.plan_thread_id)[row.plan_wave! - 1]!.testsSkipped
        && waveWorkers(row.plan_thread_id!, row.plan_wave!).at(-1)?.thread_id === row.thread_id;
      if (row.last_report_state !== "ready" && !waived) refuse(`its latest report is ${row.last_report_state ?? "missing"}, not ready.`);
      const busy = ledger.taskChain(threadId).map((id) => ledger.openReview(id)).find((review) => review && BUSY_STATUSES.has(review.state));
      if (busy) refuse(`review ${busy.thread_id} is still running; wait for its verdict.`);
      reviewSkipped = reason.data!;
    } else if (row.role === "worker") {
      const refusal = await completionRefusal(row);
      // A null refusal is a positive approval only with a verdict behind it (an approve) or on a design wave (the owner's approval).
      approved = refusal === null && (isDesignWave(row) || !!ledger.newestVerdict(row));
      if (refusal) {
        const reason = overrideSchema.safeParse(override);
        if (!reason.success || !reason.data) throw new Error(`Refusing to complete ${threadId}: ${refusal}`);
        overrideReason = reason.data;
        overrideNote = `\n\nCompleted without a matching approve: ${reason.data}`;
        bb.log.warn(`Completing ${threadId} with an override (${refusal}) Reason: ${reason.data}`);
      }
    }
    const replacement = result ? clip(result, MAX_RESULT_LENGTH) : null;
    // A replaced result drops the summary and report file that described the old one.
    const now = Date.now();
    store.markComplete({ status: live.status, result: replacement, note: overrideNote, now, threadId, cleanupApprovedAt: approved && cleanupActive ? now : null, reviewSkipped, testsSkipped: testsSkippedReason });
    const completed = store.get(threadId)!;
    enqueueCompletionComment(completed, overrideReason);
    const cleanup: "queued" | "override" | "unapproved" | "off" | null = row.role !== "worker" ? null
      : overrideNote !== null ? "override" : !approved ? "unapproved" : cleanupActive ? "queued" : "off";
    return { row: completed, overridden: overrideNote !== null, skipped: reviewSkipped !== null, cleanup };
  }

  /** chief_owner_approval: records the owner's approval on a design-wave worker whose latest report was ready.
   * Writes nothing else; the row may have gone ready -> active -> idle while the owner looked, so it is not
   * required to be in state ready, only not working, not finished, and last heard from with a ready report. */
  async function recordOwnerApproval(row: ManagedRow, approval: string) {
    if (!isDesignWave(row)) throw new Error(`${row.thread_id} is not a worker on a design-only plan wave: chief_owner_approval records only the owner's approval of a design wave.`);
    if (terminal(row.state)) throw new Error(`${row.thread_id} is ${row.state}.`);
    const live = await bb.sdk.threads.get({ threadId: row.thread_id });
    if (BUSY_STATUSES.has(live.status)) busyRejection(row, live.status, "recording the owner's approval");
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`${row.thread_id} is not a live thread.`);
    if (row.last_report_state !== "ready") throw new Error(`${row.thread_id}'s latest report is ${row.last_report_state ?? "missing"}, not ready: wait for its ready report before asking the owner.`);
    store.recordOwnerApproval(row.thread_id, approval);
    const { waves, next } = progress.nextWave(row);
    return next !== null
      ? `Recorded the owner's approval of wave ${row.plan_wave}. Delegate wave ${next}: ${waves[next - 1]!.path} — chief_delegate (planThreadId: ${row.plan_thread_id}, wave: ${next}, replaces: ${row.thread_id}); name the approved artboards in its mission.`
      : `Recorded the owner's approval of wave ${row.plan_wave}. Complete it with chief_complete (threadId: ${row.thread_id}). Never chief_review.`;
  }

  /** The line chief_complete and the CLI add for a worker's cleanup outcome; non-workers have none. */
  const cleanupLine = (cleanup: "queued" | "override" | "unapproved" | "off" | null) => cleanup === null ? "" : {
    queued: "\nCleanup queued: a background cleanup worker archives this task's threads (worker, reviewers, advisors, and the planner after its last wave) once nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there; any failure alerts you.",
    override: "\nNo cleanup: completed with override.",
    unapproved: "\nNo cleanup: no approving review.",
    off: "\nNo cleanup: the cleanupApproved setting is off.",
  }[cleanup];

  /** After a worker completes: flips its draft pull request to ready, best-effort. A forge failure
   * never undoes the completion. "skipped" means there was no pull request to flip. */
  async function readyPullRequest(row: ManagedRow): Promise<{ prReady: boolean | "skipped"; error?: string; line: string }> {
    if (row.role !== "worker" || !row.pr_url) return { prReady: "skipped", line: "" };
    const { ready, error } = await markPrReady(row.pr_url, await projectPath(row.project_id));
    return ready
      ? { prReady: true, line: "\nIts pull request is marked ready for review." }
      : { prReady: false, error, line: `\nCould not mark its pull request ready (${error}); the work is complete either way. Tell the user it is still a draft.` };
  }

  /** Interrupts a running managed thread but keeps its worktree, branch, and history:
   * the row is marked blocked (with a reroute recommendation) rather than complete, so
   * chief_delegate replaces: can hand it to a fresh worker once it is idle. */
  async function stopThread(threadId: string, reason?: string) {
    const row = store.get(threadId);
    if (!row || row.role === "chief") throw new Error(`No managed thread ${threadId} to stop.`);
    const live = await bb.sdk.threads.get({ threadId });
    if (live.deletedAt !== null || live.archivedAt !== null) throw new Error(`Cannot stop ${threadId} because it is not a live thread.`);
    if (!BUSY_STATUSES.has(live.status)) {
      throw new Error(`${threadId} is ${live.status}; nothing to stop.${row.role === "worker" ? ` Replace it with ${replacesCall(row)}.` : ""}`);
    }
    await bb.sdk.threads.stop({ threadId });
    store.markStopped(threadId, clip(`Stopped by Chief${reason ? `: ${reason}` : "."}`, 4_000), rerouteSteps(row));
    return store.get(threadId)!;
  }

  /** The outbox write itself, in no transaction of its own: report() calls it inside its store.batch. The row needs a Chief. */
  function writeAlert(row: ManagedRow, key: string, message: string) {
    const dedupeKey = `${row.thread_id}:${key}`;
    // Only an alert of the same kind (the segment before the first ":") is stale
    // once this one lands — a newer report supersedes an older undelivered report,
    // but generic lifecycle noise (idle, active, stall, ...) must never evict a
    // pending report/verdict alert Chief has not received yet.
    const kind = key.slice(0, key.indexOf(":"));
    db.prepare(`DELETE FROM alert_outbox WHERE source_thread_id=? AND delivered_at IS NULL AND dedupe_key<>? AND dedupe_key LIKE ?`)
      .run(row.thread_id, dedupeKey, `${row.thread_id}:${kind}:%`);
    db.prepare(`INSERT OR IGNORE INTO alert_outbox
      (dedupe_key, target_thread_id, source_thread_id, message, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      dedupeKey, row.chief_thread_id, row.thread_id,
      clip(`[Chief lifecycle alert]\n${message}`), Date.now(),
    );
    return dedupeKey;
  }

  /** Records a failure or stall once per (thread, cycle, kind), independent of its alert. Never throws:
   * returns the line the caller appends to its alert when the write failed, so the failure reaches Chief. */
  function recordFailure(row: ManagedRow, kind: "provider" | "stall" | "hard_stall", detail: "usage_limit" | "connection" | null) {
    try {
      if (!row.chief_thread_id) return null;
      db.prepare(`INSERT OR IGNORE INTO chief_failure_events (source_thread_id, active_cycle, kind, detail, legacy, at) VALUES (?, ?, ?, ?, 0, ?)`)
        .run(row.thread_id, row.active_cycle, kind, detail, Date.now());
      return null;
    } catch (error) {
      return `This failure could not be recorded for bb chief stats: ${clip(String(error), 200)}`;
    }
  }

  function enqueueAlert(row: ManagedRow, key: string, message: string) {
    if (!row.chief_thread_id) throw new Error(`Managed thread ${row.thread_id} has no Chief to notify.`);
    return db.transaction(() => writeAlert(row, key, message))();
  }

  /** A delivery call that stalls longer than this fails like any other, so its in-flight entry clears and the outbox retries it. */
  const ALERT_CALL_MS = 30_000;
  async function deliverAlert(key: string) {
    const existing = alertDeliveries.get(key);
    if (existing) return existing;
    const delivery = (async () => {
      const alert = db.prepare<[string]>(`SELECT * FROM alert_outbox WHERE dedupe_key=?`).get(key) as AlertRow | undefined;
      if (!alert || alert.delivered_at !== null) return true;
      // ponytail: no idempotency key, so a retry matches the text: a message BB left queued, or one already
      // in Chief's last 50 completed items. A rewritten or older-than-50 message misses and may duplicate.
      if (alert.attempts > 0) {
        try {
          const text = clip(alert.message);
          const queued = await bounded(() => bb.sdk.threads.queuedMessages.list({ threadId: alert.target_thread_id }), ALERT_CALL_MS);
          const alreadyQueued = queued.some((message) =>
            message.content.some((part) => part.type === "text" && part.text === text));
          const alreadySent = alreadyQueued || (await bounded(() => bb.sdk.threads.events.list({
            threadId: alert.target_thread_id, types: ["item/completed"], order: "desc", limit: "50",
          }), ALERT_CALL_MS)).some((event) => event.type === "item/completed" && event.data.item.type === "userMessage"
            && event.data.item.content.some((part) => part.type === "text" && part.text === text));
          if (alreadySent) {
            db.prepare(`UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
            return true;
          }
        } catch {
          // Fall through to the send below.
        }
      }
      try {
        await bounded(() => bb.sdk.threads.send({
          threadId: alert.target_thread_id,
          senderThreadId: alert.source_thread_id,
          mode: "queue-if-active",
          input: [{ type: "text", text: clip(alert.message), mentions: [] }],
        }), ALERT_CALL_MS);
        db.prepare(`UPDATE alert_outbox SET delivered_at=?, attempts=attempts+1, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(`UPDATE alert_outbox SET attempts=attempts+1, last_error=? WHERE dedupe_key=?`).run(clip(message, 1_000), key);
        bb.log.warn(`Could not deliver Chief alert ${key}: ${message}`);
        return false;
      }
    })();
    alertDeliveries.set(key, delivery);
    try {
      return await delivery;
    } finally {
      alertDeliveries.delete(key);
    }
  }

  async function alertChief(row: ManagedRow, key: string, message: string) {
    const outboxKey = enqueueAlert(row, key, message);
    return deliverAlert(outboxKey);
  }

  async function retryAlerts() {
    for (const alert of pendingAlerts.all(Date.now() - 60_000) as AlertRow[]) await deliverAlert(alert.dedupe_key);
  }

  interface ForgeCommentRow {
    dedupe_key: string; project_id: string; thread_id: string; target: string; body: string; mention: number; attempts: number;
  }
  const FORGE_COMMENT_MAX_ATTEMPTS = 5;
  /** A transient failure waits this long before the next try; the supervisor tick (30 s) is the retry clock. */
  const FORGE_COMMENT_RETRY_MS = 25_000;
  const forgeTried = new Map<string, number>();

  /** Queues a comment for the target's pull request or issue; the post happens off the caller's path.
   * Never throws and never blocks: a forge comment is an extra copy of the local record, so the state change
   * that triggered it always completes. A target that is no forge URL means no forge to post to: logged, not an error.
   * Safe inside store.batch: the drain starts after the batch commits. */
  function enqueueForgeComment(input: { key: string; row: ManagedRow; target: string | null | undefined; body: string; mention?: boolean }) {
    try {
      if (!parseForgeTarget(input.target)) {
        bb.log.info(`No forge comment for ${input.key}: ${input.target ? "its target is not a full pull request or issue URL" : "there is no pull request or issue to post on"}.`);
        return false;
      }
      db.prepare(`INSERT OR IGNORE INTO forge_comments (dedupe_key, project_id, thread_id, target, body, mention, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.key, input.row.project_id, input.row.thread_id, input.target, input.body, input.mention ? 1 : 0, Date.now());
      queueMicrotask(() => { void drainForge(); });
      return true;
    } catch (error) {
      const message = `Could not queue the forge comment ${input.key.split(":")[0]} for ${input.target}: ${errorText(error)}. The local record is intact.`;
      bb.log.warn(message);
      // Deferred so a failure inside store.batch does not write the alert into the transaction that may roll back.
      queueMicrotask(() => { void Promise.resolve().then(() => alertChief(input.row, `forge-comment:${input.key}`, message)).catch((alertError) => bb.log.error(`${message} The Chief alert also failed: ${String(alertError)}`)); });
      return false;
    }
  }

  /** One attempt for one row. attempts is persisted before any network call, so a crash mid-post reads as "maybe posted"
   * on the next try, which looks for the marker before posting again. */
  async function postForgeComment(comment: ForgeCommentRow) {
    const key = comment.dedupe_key;
    const prior = comment.attempts;
    db.prepare(`UPDATE forge_comments SET attempts=attempts+1 WHERE dedupe_key=?`).run(key);
    forgeTried.set(key, Date.now());
    try {
      const target = parseForgeTarget(comment.target);
      if (!target) throw Object.assign(new Error("the target is not a pull request or issue URL"), { code: "ENOENT" });
      const env = forgeEnv();
      if (!(prior > 0 && await hasMarker(target, key, env))) {
        const body = comment.mention ? withMention(comment.body, await ownerHandle(target, (await settings.get()).forgeOwnerHandle ?? "", env)) : comment.body;
        await postComment(target, body, env);
      }
      db.prepare(`UPDATE forge_comments SET posted_at=?, last_error=NULL WHERE dedupe_key=?`).run(Date.now(), key);
      forgeTried.delete(key);
    } catch (error) {
      const reason = errorText(error);
      const permanent = classify(error) === "permanent";
      const exhausted = !permanent && prior + 1 >= FORGE_COMMENT_MAX_ATTEMPTS;
      db.prepare(`UPDATE forge_comments SET last_error=?, gave_up_at=? WHERE dedupe_key=?`).run(reason, permanent || exhausted ? Date.now() : null, key);
      if (permanent) bb.log.info(`Forge comment ${key.split(":")[0]} on ${comment.target} not posted (the forge CLI is missing, not logged in, or the target is gone): ${reason}`);
      if (permanent || exhausted) forgeTried.delete(key);
      if (!exhausted) return;
      const row = store.get(comment.thread_id);
      const message = `Could not post the ${key.split(":")[0]} comment to ${comment.target} after ${FORGE_COMMENT_MAX_ATTEMPTS} attempts: ${reason}. The local record is intact.`;
      if (!row?.chief_thread_id) bb.log.error(message);
      else await alertChief(row, `forge-comment:${key}`, message).catch((alertError) => bb.log.error(`${message} The Chief alert also failed: ${String(alertError)}`));
    }
  }

  async function postPendingForgeComments() {
    const now = Date.now();
    const pending = db.prepare(`SELECT * FROM forge_comments WHERE posted_at IS NULL AND gave_up_at IS NULL ORDER BY created_at LIMIT 20`).all() as ForgeCommentRow[];
    for (const comment of pending) {
      if (now - (forgeTried.get(comment.dedupe_key) ?? 0) < FORGE_COMMENT_RETRY_MS) continue;
      await postForgeComment(comment);
    }
  }

  let forgeDraining: Promise<void> | null = null;
  let forgeAgain = false;
  /** Single-flight, like sweep(): an enqueue during a drain queues exactly one more pass. Callers never await it. */
  function drainForge() {
    if (forgeDraining) { forgeAgain = true; return forgeDraining; }
    forgeDraining = (async () => {
      do {
        forgeAgain = false;
        await postPendingForgeComments();
      } while (forgeAgain);
    })().catch((error) => bb.log.warn(`Forge comment drain failed; the supervisor tick retries: ${String(error)}`)).finally(() => { forgeDraining = null; });
    return forgeDraining;
  }

  /** Which attempt at a task this is: the worker's position in its replaces: chain. */
  const taskRound = (workerThreadId: string) => ledger.taskChain(workerThreadId).length;
  /** Agent- or tool-originated text, made safe for the forge and bounded. */
  const forgeText = (text: string, limit: number) => sanitizeForge(clip(text.trim(), limit));

  /** One comment per pull request a verdict covers (a branch review: its own pull request, when it was given as a full URL). Runs inside report()'s store.batch. */
  function enqueueVerdictComments(row: ManagedRow, seq: number, verdict: string, findingList: ReportFinding[] | undefined, result: string | undefined, recommendation: string | undefined) {
    const targets = ledger.targets(row.thread_id);
    const covered = targets.length
      ? targets.map((target) => ({ worker: target.worker_thread_id, url: target.pr_url ?? store.get(target.worker_thread_id)?.pr_url, sha: target.head_sha, id: `verdict:${row.thread_id}:${seq}:${target.worker_thread_id}` }))
      : [{ worker: null, url: row.pr_url, sha: row.reviewed_head_sha, id: `verdict:${row.thread_id}:${seq}` }];
    const blocking = findingList?.filter((finding) => finding.severity === "blocking") ?? [];
    const nits = findingList?.filter((finding) => finding.severity === "nit") ?? [];
    const details = sanitizeForge([
      ...(blocking.length ? ["### Blocking findings", "", ...findingLines(blocking, "blocking"), ""] : []),
      ...(nits.length ? ["### Nits", "", ...findingLines(nits, "nit"), ""] : []),
      ...(result ? ["### Findings", "", result, ""] : []),
      ...(recommendation ? ["### Recommendation", "", recommendation] : []),
    ].join("\n"));
    for (const entry of covered) {
      enqueueForgeComment({
        key: entry.id, row, target: entry.url,
        body: composeComment({
          key: entry.id, title: "Review verdict", round: entry.worker ? taskRound(entry.worker) : undefined,
          lines: [
            verdict === "approve" ? "**Approved**" : "**Changes requested**",
            ...(entry.sha ? [`Reviewed head: \`${entry.sha.slice(0, 12)}\``] : []),
            `${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}, ${nits.length} nit${nits.length === 1 ? "" : "s"}`,
          ],
          details: { summary: "Findings and recommendation", body: details },
        }),
      });
    }
  }

  /** A worker's blocked report, on its pull request (its issue when it has none). Runs inside report()'s store.batch. */
  function enqueueBlockedComment(row: ManagedRow, seq: number, blocker: string | undefined, recommendation: string | undefined) {
    const id = `blocked:${row.thread_id}:${seq}`;
    enqueueForgeComment({
      key: id, row, target: row.pr_url ?? row.issue_url,
      body: composeComment({ key: id, title: "Blocked", round: taskRound(row.thread_id), lines: [
        `**Blocker:** ${forgeText(blocker ?? "", 1_500)}`, ...(recommendation ? [`**Recommendation:** ${forgeText(recommendation, 1_500)}`] : []),
      ] }),
    });
  }

  /** A worker task's outcome, on its tracking issue (its pull request when the repository has no issue). Called once markComplete has committed. */
  function enqueueCompletionComment(row: ManagedRow, overrideReason: string | null) {
    if (row.role !== "worker") return;
    const id = `complete:${row.thread_id}`;
    const waves = row.plan_thread_id ? planWavesFor(row.plan_thread_id).length : 0;
    const details = [
      ...(row.result ? [forgeText(row.result, 4_000)] : []),
      ...(row.owner_approval ? ["", `Owner's approval: “${forgeText(row.owner_approval, 1_000)}”`] : []),
    ].join("\n");
    enqueueForgeComment({
      key: id, row, target: row.issue_url ?? row.pr_url,
      body: composeComment({
        key: id, title: "Completed", round: taskRound(row.thread_id),
        lines: [
          `**${forgeText(row.title, 160)}**${row.plan_wave && waves ? ` · wave ${row.plan_wave} of ${waves}` : ""}`,
          ...(row.pr_url ? [`Pull request: ${row.pr_url}`] : []),
          ...(overrideReason ? [`**Completed without a matching approve:** ${forgeText(overrideReason, 1_000)}`] : []),
          ...(row.unplanned_reason ? [`**Planning skipped:** ${forgeText(row.unplanned_reason, 500)}`] : []),
          ...(row.review_skipped ? [`**Review skipped:** ${forgeText(row.review_skipped, 500)}`] : []),
          ...(row.tests_skipped ? [`**Tests skipped:** ${forgeText(row.tests_skipped, 500)}`] : []),
          // The waived test waves of this worker's chain (an absent one is off the chain, so compare chain heads).
          ...(row.plan_thread_id && row.plan_wave != null ? ((plan) => plan.flatMap((wave, index) => wave.testsSkipped && chainOf(plan, index + 1)[0] === chainOf(plan, row.plan_wave!)[0]
            ? [`**Tests skipped (wave ${index + 1}):** ${forgeText(wave.testsSkipped, 500)}`] : []))(planWavesFor(row.plan_thread_id)) : []),
        ],
        details: { summary: "Result", body: details },
      }),
    });
  }

  /** The server, not the planner, owns writing the plan: the planner submits it
   * through chief_report and this lands it in the shared artifact folder (see artifactDir). */
  async function writePlan(threadId: string, projectId: string, plan: string | { body: string }[], mirrorFor?: string) {
    const bodies = typeof plan === "string" ? [{ name: "plan.md", body: plan }]
      : plan.map((wave, index) => ({ name: `plan-${index + 1}.md`, body: wave.body }));
    const paths = [];
    // mirrorFor writes a render copy under that thread's storage, in plans/<threadId>/: inline-vis only reads thread storage.
    for (const wave of bodies) {
      const content = `${wave.body}\n`;
      paths.push({ path: mirrorFor ? await writeStorageFile(mirrorFor, join("plans", threadId, wave.name), content)
        : await writeArtifact(threadId, projectId, wave.name, content) });
    }
    return paths;
  }

  /** Where Chief's own artifacts (plans, reports, verdicts) live: <BB data dir>/chief/<projectId>/<threadId>/ on the
   * thread's host, so every Chief instance and worktree of a project shares them and nothing lands in a checkout.
   * Falls back to the thread's storage root when the data dir is unknown. */
  const dataDirs = new Map<string, string | null>();
  async function artifactDir(threadId: string, projectId: string) {
    const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({ threadId });
    if (!dataDirs.has(hostId)) {
      // ponytail: per-process cache; a moved BB data dir needs a plugin reload
      let reason = "its thread storage root is unknown";
      const dataDir = await bb.sdk.hosts.get({ hostId }).then((host) => host.threadStorageRootPath ? dirname(host.threadStorageRootPath) : null)
        .catch((error) => { reason = `reading it failed: ${String(error)}`; return null; });
      if (dataDir) dataDirs.set(hostId, dataDir);
      else {
        bb.log.warn(`Host ${hostId}'s BB data dir is unavailable (${reason}); writing Chief artifacts to thread storage instead.`);
        // Recorded before the path is used, so a thread's storage that holds evidence is never cleared; if this throws, so does the artifact write.
        db.prepare(`INSERT OR IGNORE INTO artifact_fallbacks (thread_id, at) VALUES (?, ?)`).run(threadId, Date.now());
        return { hostId, dir: storageRootPath };
      }
    }
    return { hostId, dir: join(dataDirs.get(hostId)!, "chief", projectId, threadId) };
  }

  /** Writes one of Chief's artifacts to its shared folder and returns the absolute path. */
  async function writeArtifact(threadId: string, projectId: string, name: string, content: string) {
    const { hostId, dir } = await artifactDir(threadId, projectId);
    return atomicWrite(hostId, join(dir, name), content);
  }

  /** Writes a file under a thread's own storage root and returns its absolute path. */
  async function writeStorageFile(threadId: string, relPath: string, content: string) {
    const { hostId, storageRootPath } = await bb.sdk.threads.storageLocation({ threadId });
    // Thread storage lives on the thread's host, which need not be this plugin server's machine.
    return atomicWrite(hostId, join(storageRootPath, relPath), content);
  }

  /** Atomic: the content lands under a temp name and is moved into place, so a failed
   * write never leaves a partial file under the final name. */
  async function atomicWrite(hostId: string, path: string, content: string) {
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      await bb.sdk.files.write({ hostId, path: tmp, content, createParents: true });
      await bb.sdk.files.move({ hostId, sourcePath: tmp, destinationPath: path });
    } catch (error) {
      await bb.sdk.files.remove({ hostId, path: tmp }).catch(() => undefined);
      throw error;
    }
    return path;
  }

  /** Best-effort: keeps the exact spawn prompt in the thread's own storage so it can re-read its brief after a compaction. Never throws. */
  async function persistBrief(threadId: string, prompt: string) {
    await writeStorageFile(threadId, "brief.md", prompt).catch((error) => bb.log.warn(`Could not write ${threadId}'s brief: ${String(error)}`));
  }

  /** Writes a reviewer's review-context.md: 3 attempts (1s, 2s backoff), then alerts Chief so it stops or nudges the reviewer. Never throws. */
  async function writeReviewContext(threadId: string, content: string, workerThreadId: string) {
    let error: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      try {
        await writeStorageFile(threadId, "review-context.md", `${content}\n`);
        return;
      } catch (caught) { error = caught; }
    }
    // The worker's row names the same Chief, for when the reviewer's own row cannot be read.
    const row = [store.get(threadId), store.get(workerThreadId)].find((candidate) => candidate?.chief_thread_id);
    const message = `Could not write review-context.md for reviewer ${threadId} after 3 attempts: ${String(error)}. The reviewer will report blocked on the missing file; stop it (chief_stop) or nudge it with the context.`;
    // The alert is the last resort; its own failure is logged rather than thrown after the reviewer has launched.
    if (row) await Promise.resolve().then(() => alertChief(row, `review-context:${threadId}`, message)).catch((alertError) => bb.log.error(`${message} The Chief alert also failed: ${String(alertError)}`));
    else bb.log.error(message);
  }



  type ThreadInput = ThreadInsert<ManagedRow["role"], ManagedRow["state"]>;
  /** The caller's managed row. While insertThread has not run yet, `pending` holds the row recovered from spawn-seeded
   * metadata and nothing is written: the caller persists it with insertThread once it has decided to proceed. */
  async function lookupRow(threadId: string, callerProjectId: string): Promise<{ row?: ManagedRow; pending?: ThreadInput }> {
    const row = store.get(threadId);
    if (row) return { row };
    // configure() already falls back to pluginMetadata seeded at spawn time
    // because insertThread only runs after threads.spawn resolves; a report can
    // land in that same gap for a brand-new thread. Recover the same seed here
    // instead of throwing, so exposing the tool and executing it close together.
    // pluginMetadata is writable by any API client, another plugin, or the
    // thread's own agent, so only trust it once originPluginId proves this
    // thread was actually created by our own spawn call.
    const live = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const seeded = live?.originPluginId === bb.pluginId
      ? spawnMetadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null))
      : undefined;
    if (!seeded?.success) return {};
    return {
      pending: {
        threadId,
        role: seeded.data.role,
        projectId: live?.projectId ?? callerProjectId,
        chiefThreadId: seeded.data.chiefThreadId ?? null,
        title: live?.title ?? live?.titleFallback ?? threadId,
        state: "active",
        status: live?.status ?? "active",
      },
    };
  }

  /** The caller's managed row, persisting a spawn-seeded recovery at once. */
  async function managedRow(threadId: string, callerProjectId: string) {
    const { row, pending } = await lookupRow(threadId, callerProjectId);
    if (pending) {
      store.insert(pending);
      return store.get(threadId);
    }
    return row;
  }

  type WaveInput = { body: string; dependsOn?: number[]; design?: boolean; test?: boolean };


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
    if (found.pending) store.insert(found.pending);
    const row = store.get(threadId)!;
    // checkReport proved the shape: a wave array here is {body, dependsOn?, design?, test?}[], with bodies not yet trimmed if JSON-decoded.
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
        ...(typeof planInput !== "string" && planInput[index]!.test ? { test: true } : {}) }))
      : null;
    // Best-effort mirror into Chief's storage: inline-vis resolves paths against the rendering thread.
    let inlinePlans: string[] = [];
    if (planWaves && planInput && row.chief_thread_id) {
      try {
        await writePlan(threadId, row.project_id, planInput, row.chief_thread_id);
        inlinePlans = planWaves.map((wave) => `::inline-vis{source="thread-storage" file="plans/${threadId}/${basename(wave.path)}"}`);
      } catch (error) {
        bb.log.warn(`Could not mirror ${threadId}'s plan into Chief's storage: ${String(error)}`);
      }
    }
    // checkReport proved the shape: reportFails is an array of {text, scope, basis} or unset.
    const failList = reportFails as z.infer<typeof reportFailEntry>[] | undefined;
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
    const action = nextAction(current, true) ?? waveWaitLine(current)
      ?? (row.role === "researcher" ? "Research is advisory: use its findings, check anything doubtful against the code, and note any failures or timeout it reports. Nothing to review or complete." : null)
      ?? "Inspect live evidence with chief_inspect and choose: continue, review, complete, or escalate to the user.";
    const recorded = row.role === "worker" && params.state === "ready" ? await recordedCommands(threadId) : undefined;
    const verdictName = `verdict-${seq}.md`;
    const reportName = `report-${seq}.md`;
    const reviewerVerdict = row.role === "reviewer" && !!verdict;
    // Best-effort: the verdict is in the DB either way, so a failed write only loses the file.
    let verdictPath: string | null = null;
    const reviewedTargets = reviewerVerdict ? ledger.targets(threadId) : [];
    if (reviewerVerdict) {
      try {
        verdictPath = await writeArtifact(threadId, row.project_id, verdictName, verdictFileBody({
          threadId, verdict, regressionFlag, reviewedTargets, workerThreadId: row.worker_thread_id, reviewedHeadSha: row.reviewed_head_sha,
          findingList, result: params.result, recommendation: params.recommendation,
        }));
      } catch (error) {
        bb.log.warn(`Could not write ${threadId}'s verdict file: ${String(error)}`);
      }
    }
    const longResult = (params.result?.length ?? 0) > SUMMARY_MAX;
    // A reviewer's full findings live in the verdict file: the alert carries a preview and where to read the rest.
    const preview = reviewerVerdict && !!verdictPath && !!params.result;
    const waveLines = plannerReady && planWaves ? planWaves.map((wave, index) => `Wave ${index + 1} of ${planWaves.length}: ${wave.path}`) : [];
    const layout = reportAlert({ role: row.role, title: row.title, threadId, params, action, recorded, failList, verdict, verdictPath, waveLines, inlinePlans, preview });
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
          role: row.role, title: row.title, threadId, params, verdict, action, waveLines, inlinePlans, recorded,
        }));
        pointer = { line: `Full report: ${reportPath}`, name: reportName };
      } catch (error) {
        bb.log.warn(`Could not write ${threadId}'s report file: ${String(error)}`);
        pointer = { line: `Full report: could not write ${reportName} (see the plugin log)`, name: null };
      }
      alert = layout(pointer).text;
    }
    // Guarded by report_seq, and report_path also by result_rev: a slow write never attaches its path to a
    // newer report, nor to a result chief_complete replaced meanwhile (even with identical text). Always runs, so a
    // report without a verdict still clears the previous verdict_path as the main UPDATE used to.
    store.attachReportFiles(threadId, seq, resultRev, verdictPath, reportPath);
    const contentKey = createHash("sha1").update(alert).digest("hex").slice(0, 16);
    return alertChief(store.get(threadId) ?? current, `report:${current.active_cycle}:${contentKey}`, alert);
  }

  function stateFromLive(row: ManagedRow, status: string) {
    // Complete is Chief's decision, not a live status: nothing the thread does later reopens it.
    if (row.state === "complete") return "complete";
    if (status === "error") return "failed";
    if (["ready", "blocked", "complete"].includes(row.state)) return row.state;
    if (["active", "starting", "pending", "stopping"].includes(status)) return status;
    return "idle";
  }

  async function reconcileThread(row: ManagedRow, sectionId: string) {
    let thread;
    try {
      thread = await bb.sdk.threads.get({ threadId: row.thread_id });
    } catch (error) {
      bb.log.warn(`Transient thread read failure for ${row.thread_id}; will retry: ${String(error)}`);
      return false;
    }
    const now = Date.now();
    if (thread.deletedAt !== null) {
      store.markDeleted(row.thread_id, now);
      return true;
    }
    if (thread.archivedAt !== null) {
      if (row.state === "archived") return true;
      store.markArchived(row.thread_id, thread.status, now);
      return true;
    }
    if (thread.sectionId !== sectionId || thread.visibility !== "visible") {
      try {
        await bb.sdk.threads.update({ threadId: row.thread_id, sectionId, visibility: "visible" });
      } catch (error) {
        bb.log.warn(`Transient thread filing failure for ${row.thread_id}; will retry: ${String(error)}`);
      }
    }
    // The reads above may have spanned a report or lifecycle event: decide from the row as it is now (#127), never the one captured before them.
    const current = store.get(row.thread_id);
    if (!current) return true;
    row = current;
    const parentChanged = !!thread.parentThreadId && row.parent_thread_id !== thread.parentThreadId;
    const nextState = stateFromLive(row, thread.status) as ManagedRow["state"];
    // Unchanged: skip the write and the reload, which recomputes every Chief's checklist.
    if (!parentChanged && nextState === row.state && thread.status === row.status && (nextState !== "active" || row.active_since !== null)) return true;
    const enteringActive = nextState === "active" && row.state !== "active";
    // One reload covers the parent write and the state write.
    store.batch(() => {
      if (parentChanged) store.setParent(row.thread_id, thread.parentThreadId!, now);
      store.syncLive({
        threadId: row.thread_id, state: nextState, status: thread.status,
        activeSince: nextState === "active" ? (row.state === "active" ? row.active_since ?? now : now) : null,
        enteringActive, now,
      });
    });
    return true;
  }

  async function reconcile() {
    const sectionId = await ensureSection();
    // A complete or deleted row never changes state again (stateFromLive), so only open rows cost a read.
    for (const row of store.all()) {
      if (row.state !== "deleted" && row.state !== "complete") await reconcileThread(row, sectionId);
    }
    const projects = new Set(store.all().map((row) => row.project_id));
    const configured = (await settings.get()).chiefProject;
    if (configured) projects.add(configured);
    for (const projectId of projects) await readRules(projectId);
  }

  async function lifecycle(kind: string, thread: { id: string; status?: string }) {
    // Before the early returns: the blocker may be unmanaged, hidden, or already complete.
    if ((kind === "idle" || kind === "failed") && pendingReady) void sweep();
    const row = store.get(thread.id);
    if (!row) return;
    // Complete is final: an archive (often Chief's own auto-archive) keeps the row complete, so a
    // planner waiting on its final-wave worker still sees it complete; only a delete moves it.
    if (row.state === "complete" && kind !== "deleted") return;
    const now = Date.now();
    if (row.role === "chief") {
      const state = kind === "active" ? "active"
        : kind === "idle" ? "idle"
          : kind === "failed" ? "failed"
            : kind === "archived" ? "archived" : "deleted";
      store.recordState(thread.id, state, thread.status ?? state, now);
      return;
    }
    if (kind === "active") {
      const enteringActive = row.state !== "active";
      store.markActive(thread.id, thread.status ?? "active", enteringActive ? now : row.active_since ?? now, enteringActive, now);
      return;
    }
    const observed = kind === "idle" ? "idle" : kind === "failed" ? "failed" : kind === "archived" ? "archived" : "deleted";
    const state = observed === "idle" && ["ready", "blocked", "complete"].includes(row.state) ? row.state : observed;
    store.recordState(thread.id, state, thread.status ?? observed, now);
    if (kind !== "failed" || !row.chief_thread_id) return;
    const failure = await lastProviderError(thread.id);
    const transient = failure && transientFailure(failure.text);
    if (!failure || !transient) {
      // ponytail: a repeated failed event while already failed is the same failure, not a second one.
      if (row.state !== "failed") {
        store.countError(thread.id);
      }
      // `error:` never `failed:`, so the legacy backfill never copies a non-transient failure; the outbox dedupes per cycle.
      await alertChief(row, `error:${row.active_cycle}`, [
        `${row.role} “${row.title}” (${row.thread_id}) failed.`,
        ...(failure ? [`Provider error: ${clip(failure.text, 400)}`] : ["No provider error was recorded."]),
        rerouteSteps(row),
      ].join("\n"));
      return;
    }
    const { usageLimit, resetSeconds } = transient;
    const unrecorded = recordFailure(row, "provider", usageLimit ? "usage_limit" : "connection");
    const cooling = usageLimit ? await noteCooldown(thread.id, failure) : null;
    const resetAt = resetSeconds === null ? null : failure.at + resetSeconds * 1000;
    const minutes = resetAt === null ? null : Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000) + 1);
    const backoff = minutes !== null ? `${minutes}m` : usageLimit ? "15m" : "2m";
    await alertChief(row, `failed:${row.active_cycle}`, [
      `${row.role} “${row.title}” (${row.thread_id}) failed on a transient provider error: ${usageLimit ? "provider usage limit (HTTP 429)" : "connection/provider error"}.`,
      `Provider error: ${clip(failure.text, 400)}`,
      ...(!usageLimit ? [] : resetAt !== null
        ? [`Usage limit resets at ${new Date(resetAt).toISOString()} (about ${minutes} min from now).`]
        : ["The error does not say when the usage limit resets."]),
      ...(cooling ? [`New chief_delegate/chief_review/chief_plan/chief_consult/chief_research work on ${cooling.providerId}/${cooling.model} is refused until ${new Date(cooling.until).toISOString()}; other models on ${cooling.providerId} stay usable.`] : []),
      `Do not spawn a replacement: a fresh thread on the same provider and model hits the same error. Retry this same thread with: bb thread retry ${row.thread_id} --send-at ${backoff} --reason "${usageLimit ? "usage limit reset" : "transient provider error"}"`,
      "If the retry fails the same way again, escalate to the user (wait for the limit or switch provider/model) instead of retrying again.",
      ...(unrecorded ? [unrecorded] : []),
    ].join("\n"));
  }

  bb.events.on("thread.active", ({ thread }) => lifecycle("active", thread));
  bb.events.on("thread.idle", ({ thread }) => lifecycle("idle", thread));
  bb.events.on("thread.failed", ({ thread }) => lifecycle("failed", thread));
  bb.events.on("thread.archived", ({ thread }) => lifecycle("archived", thread));
  bb.events.on("thread.deleted", ({ thread }) => lifecycle("deleted", thread));

  bb.background.service("supervisor", {
    async start(signal) {
      const wake = () => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, RECONCILE_INTERVAL_MS);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      while (!signal.aborted) {
        try {
          await reconcile();
          await sweep(); // safety net for idle events missed across a reload, or a blocker archived without idling
          await checkUnreported(store.all());
          const values = await settings.get();
          cleanupActive = values.cleanupApproved;
          const parsed = Number(values.stallMinutes);
          const threshold = (Number.isFinite(parsed) && parsed > 0 ? parsed : 15) * 60_000;
          const now = Date.now();
          for (const row of store.all()) {
            if (row.role === "chief" || row.state !== "active" || row.active_since === null) continue;
            const elapsed = now - row.active_since;
            if (elapsed < threshold) continue;
            const hard = elapsed >= 2 * threshold;
            if ((hard ? row.stop_alerted_cycle : row.stall_alerted_cycle) === row.active_cycle) continue;
            // Every tick until sent re-enters here; the primary key keeps one row.
            const unrecorded = recordFailure(row, hard ? "hard_stall" : "stall", null);
            const output = await lastOutput(row.thread_id);
            const minutes = Math.round(threshold / 60_000);
            const sent = await alertChief(row, `stall:${row.active_cycle}${hard ? ":hard" : ""}`, [
              `${row.role} “${row.title}” (${row.thread_id}) has been active for ${Math.round(elapsed / 60_000)} minutes${hard ? `, twice the ${minutes}-minute stall threshold` : ` (stall threshold ${minutes})`}.`,
              `Last output: ${output ? clip(output, 400) : "(none available)"}`,
              hard
                ? "Stop it now with chief_stop unless that output shows it finishing. Its worktree and branch are kept."
                : `Inspect it with chief_inspect. If it is progressing, leave it. If it is stuck or looping, chief_stop it: its worktree and branch are kept. At ${2 * minutes} minutes you will be told to stop it.`,
              rerouteSteps(row),
              ...(unrecorded ? [unrecorded] : []),
            ].join("\n"));
            if (sent) {
              store.markStallAlerted(row.thread_id, row.active_cycle, hard ? row.active_cycle : row.stop_alerted_cycle);
            }
          }
          // Hand an archived or deleted Chief's open work to the project's live Chief, starting
          // one if none is left. A failed Chief is not replaced: a failed turn is recoverable
          // (touchCallerChief), and its next event returns it to idle or active. Alerts from
          // open work follow the work; an alert whose source is already finished is not worth
          // a new Chief the user just deleted.
          const orphanedChiefs = store.all().filter((row) =>
            row.role === "chief" && (row.state === "archived" || row.state === "deleted")
            && store.all().some((child) => child.chief_thread_id === row.thread_id && !["failed", "deleted", "archived", "complete"].includes(child.state)));
          for (const orphaned of orphanedChiefs) {
            const next = await ensureChief(orphaned.project_id);
            if (next.threadId !== orphaned.thread_id) handOver(orphaned.thread_id, next.threadId, orphaned.project_id);
          }
          if (values.autoSpawn && values.chiefProject) await ensureChief(values.chiefProject);
          // Replace terminal Chiefs and retarget their queued alerts before any
          // pending delivery is attempted.
          await retryAlerts();
          await observeCleanup();
          void drainForge();
        } catch (error) {
          bb.log.warn(`Supervisor reconciliation failed: ${String(error)}`);
        }
        await wake();
      }
    },
  });

  settings.onChange((next, previous) => {
    if (next.autoSpawn && next.chiefProject && next.chiefProject !== previous.chiefProject) {
      void ensureChief(next.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
    }
    plannerActive = next.plannerEnabled;
    cleanupActive = next.cleanupApproved;
    researchActive = researchFrom(next);
  });

  function rosterFor(projectId: string, includeComplete = false) {
    return store.all().filter((row) => row.project_id === projectId && (includeComplete || row.state !== "complete"));
  }

  /** A hand-off from a tester or a test-wave worker must name its kind (see explicitKind in startWorker). */
  function replacesCall(row: ManagedRow): string {
    return row.kind === "tester" || isTestWave(row)
      ? `chief_delegate (replaces: ${row.thread_id}, kind: worker) for a product-code fix or chief_delegate (replaces: ${row.thread_id}, kind: tester) for a test fix`
      : `chief_delegate (replaces: ${row.thread_id})`;
  }

  /** Said the same way in chief_stop's reply and both stall alerts. */
  function rerouteSteps(row: ManagedRow): string {
    if (row.role === "worker") {
      return `Once it is idle, call chief_consult (workerThreadId: ${row.thread_id}) if the cause is unclear, then hand the work to a fresh worker with ${replacesCall(row)} and the advice in its context. Use chief_plan instead if the brief itself is wrong or too big.`;
    }
    if (row.role === "reviewer") {
      return row.worker_thread_id
        ? `Once it is idle, start a fresh review with chief_review (workerThreadId: ${row.worker_thread_id}).`
        : `Once it is idle, chief_complete it, then start a fresh chief_review for branch ${row.branch}.`;
    }
    if (row.role === "planner" && row.replaces_thread_id) return `Once it is idle, start a fresh chief_plan (revises: ${row.replaces_thread_id}) with a narrower brief; the review round is already used.`;
    if (row.role === "planner") return "Once it is idle, start a fresh chief_plan with a narrower brief.";
    if (row.role === "advisor" && row.plan_thread_id) return `Once it is idle, start a fresh chief_consult (planThreadId: ${row.plan_thread_id}); the plan still needs its one review.`;
    if (row.role === "researcher") return "Once it is idle, decide without it or start a fresh chief_research with a narrower question.";
    return "Once it is idle, decide without it or start a fresh chief_consult with a narrower question.";
  }

  function belongsToChief(row: ManagedRow, chiefThreadId: string) {
    return row.thread_id === chiefThreadId || row.chief_thread_id === chiefThreadId;
  }

  // Mutation/reference check: only directly owned work, never the Chief itself. BB's parent_thread_id
  // is provenance, not ownership. These rules keep cooperating agents organised; they are not a
  // security boundary.
  function controlsThread(row: ManagedRow, callerChiefId: string) {
    return row.thread_id !== callerChiefId && row.chief_thread_id === callerChiefId;
  }

  /** The one target assertion behind every tool and managed-Chief CLI call that acts on another thread. */
  async function controlledTarget(threadId: string, caller: ManagedRow) {
    const target = await resolveTarget(threadId, caller.thread_id);
    if (!target || target.project_id !== caller.project_id || !controlsThread(target, caller.thread_id)) {
      throw new Error(`No managed thread ${threadId} for this Chief.`);
    }
    return target;
  }

  /** The last 3 reviewer rows with a verdict for this worker's task, so the
   * advisor sees the review history that led to the consult, across a `replaces`
   * handoff. */
  function taskReviews(worker: ManagedRow): ManagedRow[] {
    const workerIds = new Set(ledger.taskChain(worker.thread_id));
    return store.all()
      .filter((row) => row.role === "reviewer" && row.verdict && row.worker_thread_id && workerIds.has(row.worker_thread_id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 3);
  }

  const INACTIVE_CHIEF_STATES = ["complete", "archived", "deleted"];
  /** A superseded Chief (spawnChief already marked it complete/archived/deleted and
   * handed its workers to the replacement) must not still be able to act as Chief. */
  function isActiveChief(caller: ManagedRow | undefined): caller is ManagedRow {
    return !!caller && caller.role === "chief" && !INACTIVE_CHIEF_STATES.includes(caller.state);
  }

  /** The one guard in front of every way to start a reviewer: only the active Chief may. */
  function requireChiefCaller(caller: ManagedRow | undefined, what: string): asserts caller is ManagedRow {
    if (isActiveChief(caller)) return;
    const role = (caller as ManagedRow | undefined)?.role;
    throw new Error(`${what} is for the active Chief only: ${role && role !== "chief" ? `a managed ${role} reports ready with chief_report, and Chief starts the review` : "ask the active Chief to start it"}.`);
  }

  async function resolveTarget(threadId: string, chiefThreadId: string): Promise<ManagedRow | undefined> {
    let target = store.get(threadId);
    if (!target) {
      try {
        const live = await bb.sdk.threads.get({ threadId });
        const chief = store.get(chiefThreadId);
        if (
          live.deletedAt === null && live.archivedAt === null &&
          live.parentThreadId === chiefThreadId && chief && live.projectId === chief.project_id
        ) {
          // Only adopt threads this plugin itself spawned (pluginMetadata seeded at
          // spawn time, trusted only once originPluginId proves it — see report()'s
          // identical check) — otherwise a sub-thread the user created under Chief in
          // the BB UI gets silently relocated into the Chief section as a "worker".
          const seeded = live.originPluginId === bb.pluginId
            ? spawnMetadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null))
            : undefined;
          if (seeded?.success && seeded.data.role !== "chief" && seeded.data.chiefThreadId === chiefThreadId) {
            store.insert({
              threadId: live.id,
              role: seeded.data.role,
              projectId: live.projectId,
              chiefThreadId,
              parentThreadId: chiefThreadId,
              title: live.title || "Managed thread",
              state: live.status === "active" ? "active" : "idle",
              status: live.status,
            });
            target = store.get(threadId);
          }
        }
      } catch {
        // not found
      }
    }
    return target;
  }

  function rosterForChief(chiefThreadId: string, includeComplete = false) {
    return store.all().filter(
      (row) => belongsToChief(row, chiefThreadId) && (includeComplete || row.state !== "complete"),
    );
  }

  const SEGMENT_LABELS = { notDelegated: "not delegated", approved: "approved", changesRequested: "changes requested", inReview: "in review" } as const;

  /** A planner's wave schedule and how far it has been delegated, or a worker's own
   * wave — shared by chief_roster and bb chief status so the two never disagree either. */
  function waveLines(row: ManagedRow): string[] {
    if (row.role === "planner" && row.plan_waves) {
      const waves = planWavesFor(row.thread_id);
      const { done, total, segments } = progress.waveProgress(row);
      const segmentLabel = (state: SegmentState) => (state.kind === "worker" ? state.state : SEGMENT_LABELS[state.kind]);
      return [
        `waves: ${done}/${total} done, ${segments.map((segment) => `wave ${segment.wave} ${segmentLabel(segment.state)}`).join(", ")}`,
        ...waves.map((wave, index) => `  wave ${index + 1} of ${waves.length}: ${wave.path}${
          wave.dependsOn ? wave.dependsOn.length ? ` (after wave ${wave.dependsOn[0]})` : " (independent)" : ""}${wave.testsSkipped ? `: tests skipped: ${clip(wave.testsSkipped, 200)}` : ""}`),
      ];
    }
    if (row.role === "worker" && row.plan_thread_id && row.plan_wave != null) {
      return [`wave: ${row.plan_wave} of ${planWavesFor(row.plan_thread_id).length} (plan ${row.plan_thread_id})`];
    }
    return [];
  }

  /** One row's full detail block, reused by chief_roster and bb chief status. */
  /** The roster's plan-review lines: a planner's review status, a revision's original, a plan advisor's planner. */
  function planReviewLines(row: ManagedRow): string[] {
    if (row.role === "advisor" && row.plan_thread_id) return [`reviews plan: ${row.plan_thread_id}`];
    if (row.role !== "planner") return [];
    const lines = row.replaces_thread_id ? [`revises: ${row.replaces_thread_id}`] : [];
    if (!row.plan_review) return lines;
    const { inFlight, decider } = planAdvisors(row.thread_id);
    const revised = revisionsOf(row.thread_id).ready;
    const status = row.plan_review === "required"
      ? inFlight ? `in review (${inFlight.thread_id})` : "required"
      : row.plan_review === "approved" ? `approved (${decider?.thread_id ?? "?"})`
      : row.state === "complete" && revised ? `revised by ${revised.thread_id}` : `changes requested (${decider?.thread_id ?? "?"})`;
    return [...lines, `plan review: ${status}`];
  }

  function rosterRowLines(row: ManagedRow): string[] {
    return [
      `${row.role} | ${row.state} | live:${row.status ?? "unknown"} | ${row.title} | ${row.thread_id}`,
      ...(row.kind ? [`kind: ${row.kind}`] : []),
      ...(row.branch ? [`branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`pr: ${row.pr_url}`] : []),
      ...waveLines(row),
      ...planReviewLines(row),
      ...(row.unplanned_reason ? [`unplanned: ${clip(row.unplanned_reason, 200)}`] : []),
      ...(row.review_skipped ? [`review skipped: ${clip(row.review_skipped, 200)}`] : []),
      ...(row.tests_skipped ? [`tests skipped: ${clip(row.tests_skipped, 200)}`] : []),
      ...(row.summary || row.result ? [`result: ${row.summary ?? clip(row.result!, 300)}`] : []),
      ...(row.report_path ? [`report: ${row.report_path}`] : []),
      ...(row.blocker ? [`blocker: ${clip(row.blocker, 200)}`] : []),
      ...(row.recommendation ? [`recommendation: ${clip(row.recommendation, 200)}`] : []),
      ...(row.verdict ? [`verdict: ${row.verdict}`] : []),
    ];
  }

  /** bb chief stats: a read-only summary of the given rows, their alert rows and todos. */
  function chiefStats(scope: { projectId: string; chiefThreadId: string | null }, rows: ManagedRow[], todos: TodoRow[]) {
    const ids = new Set(rows.map((row) => row.thread_id));
    const alerts = new Map<string, { usageLimit: number; connection: number; stalls: number; hardStalls: number }>();
    const approximate = { usageLimit: 0, connection: 0, stalls: 0, hardStalls: 0 };
    const events = db.prepare(`SELECT source_thread_id, kind, detail, legacy FROM chief_failure_events`).all() as { source_thread_id: string; kind: string; detail: string | null; legacy: number }[];
    for (const event of events) {
      if (!ids.has(event.source_thread_id)) continue;
      const counts = alerts.get(event.source_thread_id) ?? { usageLimit: 0, connection: 0, stalls: 0, hardStalls: 0 };
      const field = event.kind === "provider" ? (event.detail === "usage_limit" ? "usageLimit" : "connection") : event.kind === "hard_stall" ? "hardStalls" : "stalls";
      counts[field] += 1;
      if (event.legacy === 1) approximate[field] += 1;
      alerts.set(event.source_thread_id, counts);
    }
    // ponytail: the branch fallback is a heuristic, so a branch reused by a later unplanned
    // task merges into one task; replaces_thread_id makes this precise from stats_since on.
    const keys = new Map<string, string | null>();
    const keyOf = (row: ManagedRow | undefined): string | null => {
      if (!row) return null;
      if (keys.has(row.thread_id)) return keys.get(row.thread_id)!;
      keys.set(row.thread_id, null);
      const branch = row.branch ? `branch:${row.project_id}:${row.branch}` : null;
      const viaLink = (id: string | null | undefined) => (id ? keyOf(store.get(id)) : null);
      const key = row.role === "planner" ? `plan:${row.thread_id}`
        : row.role === "worker" ? (row.plan_thread_id ? `plan:${row.plan_thread_id}` : viaLink(row.replaces_thread_id) ?? branch ?? `worker:${row.thread_id}`)
        : row.role === "reviewer" ? viaLink(row.worker_thread_id) ?? branch
        : row.role === "advisor" ? viaLink(row.worker_thread_id)
        : null;
      keys.set(row.thread_id, key);
      return key;
    };
    const groups = new Map<string, ManagedRow[]>();
    for (const row of rows) {
      const key = keyOf(row);
      if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    const failuresOf = (list: ManagedRow[]) => {
      const counts = list.map((row) => alerts.get(row.thread_id));
      return {
        usageLimit: sum(counts.map((c) => c?.usageLimit ?? 0)),
        connection: sum(counts.map((c) => c?.connection ?? 0)),
        threadErrors: sum(list.map((row) => row.thread_errors)),
        busyRejections: sum(list.map((row) => row.busy_rejections)),
        stalls: sum(counts.map((c) => c?.stalls ?? 0)),
        hardStalls: sum(counts.map((c) => c?.hardStalls ?? 0)),
      };
    };
    // Verdict history is the source for approve/request_changes counts; a reviewer from before reviewer_verdicts
    // existed has no rows, so its row's current verdict stands in for the one it gave.
    const verdictsBy = new Map<string, string[]>();
    for (const entry of db.prepare(`SELECT reviewer_thread_id, verdict FROM reviewer_verdicts GROUP BY reviewer_thread_id, report_seq ORDER BY MIN(id)`).all() as { reviewer_thread_id: string; verdict: string }[]) {
      if (ids.has(entry.reviewer_thread_id)) verdictsBy.set(entry.reviewer_thread_id, [...(verdictsBy.get(entry.reviewer_thread_id) ?? []), entry.verdict]);
    }
    const verdictsOf = (list: ManagedRow[]) => list.filter((row) => row.role === "reviewer")
      .flatMap((row) => verdictsBy.get(row.thread_id) ?? (row.verdict ? [row.verdict] : []));
    const terminal = ["complete", "archived", "deleted"];
    const perTask = [...groups].filter(([, list]) => list.some((row) => row.role === "planner" || row.role === "worker")).map(([key, list]) => {
      const planner = list.find((row) => row.role === "planner");
      const workers = list.filter((row) => row.role === "worker").sort((a, b) => a.created_at - b.created_at);
      const latest = workers.at(-1);
      // A worker completed before its plan's final wave means the plan stopped mid-way: dropped.
      const status = !latest ? (planner && terminal.includes(planner.state) ? "dropped" : "open")
        : latest.state === "complete" && progress.onFinalWave(latest) ? "completed"
        : terminal.includes(latest.state) ? "dropped"
        : "open";
      const waves = key.startsWith("plan:") ? new Set(workers.map((row) => row.plan_wave)).size : 1;
      const verdicts = verdictsOf(list);
      // ponytail: a complete row's updated_at is its completion time; nothing rewrites a complete row except a delete.
      const start = Math.min(...[planner, ...workers].map((row) => row?.created_at ?? Infinity));
      return {
        key, title: planner?.title ?? workers[0]?.title ?? key, status, workers: workers.length, waves,
        replacements: Math.max(0, workers.length - waves),
        approvals: verdicts.filter((verdict) => verdict === "approve").length,
        requestChanges: verdicts.filter((verdict) => verdict === "request_changes").length,
        category: (key.startsWith("plan:") || workers.some((row) => row.plan_thread_id) ? "planned"
          : workers[0]?.simple === 1 ? "simple"
          : workers[0]?.planner_on == null ? "unknown"
          : workers[0].planner_on === 1 ? "unplanned_planner_on" : "unplanned_planner_off") as "planned" | "simple" | "unknown" | "unplanned_planner_on" | "unplanned_planner_off",
        consults: list.filter((row) => row.role === "advisor").length,
        ...failuresOf(list),
        wallTimeMs: status === "completed" ? latest!.updated_at - start : null,
      };
    });
    const times = perTask.map((task) => task.wallTimeMs).filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const mid = times.length >> 1;
    const statsSince = (db.prepare(`SELECT value FROM plugin_meta WHERE key='stats_since'`).get() as { value: string } | undefined)?.value;
    const since = statsSince === undefined ? null : Number(statsSince);
    const eventsSince = (db.prepare(`SELECT value FROM plugin_meta WHERE key='failure_events_since'`).get() as { value: string } | undefined)?.value;
    const exactSince = eventsSince === undefined ? null : Number(eventsSince);
    const count = (status: string) => perTask.filter((task) => task.status === status).length;
    const todoCount = (state: TodoRow["state"]) => todos.filter((todo) => todo.state === state).length;
    const reviewers = rows.filter((row) => row.role === "reviewer");
    const verdicts = verdictsOf(rows);
    const requestChanges = verdicts.filter((verdict) => verdict === "request_changes").length;
    const categoryCount = (category: string) => perTask.filter((task) => task.category === category).length;
    const researchBy = new Map<string, { role: string; mode: string | null; calls: number; succeeded: number }>();
    for (const call of db.prepare(`SELECT caller_thread_id, role, mode, outcome FROM chief_research_calls ORDER BY id`).all() as { caller_thread_id: string; role: string; mode: string | null; outcome: string }[]) {
      // Chief's spawned call only started a researcher; that thread's own calls carry the real outcomes.
      if (!ids.has(call.caller_thread_id) || call.outcome === "spawned") continue;
      const entry = researchBy.get(`${call.role}\u0000${call.mode}`) ?? { role: call.role, mode: call.mode, calls: 0, succeeded: 0 };
      entry.calls += 1;
      if (call.outcome === "succeeded" || call.outcome === "partial") entry.succeeded += 1;
      researchBy.set(`${call.role}\u0000${call.mode}`, entry);
    }
    return {
      scope, statsSince: since, failureEventsSince: exactSince,
      tasks: {
        total: perTask.length, completed: count("completed"), open: count("open"), dropped: count("dropped"),
        planned: categoryCount("planned"), unplanned_planner_on: categoryCount("unplanned_planner_on"),
        unplanned_planner_off: categoryCount("unplanned_planner_off"), simple: categoryCount("simple"), unknown: categoryCount("unknown"),
      },
      verdicts: { approve: verdicts.length - requestChanges, request_changes: requestChanges },
      research: [...researchBy.values()].sort((a, b) => a.role.localeCompare(b.role) || String(a.mode).localeCompare(String(b.mode))),
      todos: { open: todoCount("open"), done: todoCount("done"), dropped: todoCount("dropped") },
      repairs: {
        replacements: sum(perTask.map((task) => task.replacements)), requestChanges,
        regressions: reviewers.filter((row) => row.regression === 1).length,
        consults: rows.filter((row) => row.role === "advisor").length,
      },
      failures: { ...failuresOf(rows), rejectedReviews: requestChanges, approximate },
      wallTimeMs: {
        completed: times.length,
        median: !times.length ? null : times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2,
        total: times.length ? sum(times) : null,
      },
      perTask,
      notes: [
        `Thread errors, busy rejections and branchless replaces chains are recorded from ${since === null ? "an unknown date" : new Date(since).toISOString()}; threads before that show 0 and may split into separate tasks.`,
        `Provider failures and stalls are counted once per thread, turn and kind when detected, whether or not their alert reached Chief, exactly from ${exactSince === null ? "an unknown date" : new Date(exactSince).toISOString()}. ${sum(Object.values(approximate))} of them (usage limit ${approximate.usageLimit}, connection ${approximate.connection}, stalls ${approximate.stalls}, hard stalls ${approximate.hardStalls}) were copied from older alerts and are approximate: an undelivered alert replaced by a newer one was lost, and a task title naming a usage limit counted a connection failure as one. A failure the classifier does not recognise is counted as a thread error.`,
        "A deleted thread loses its completed state, so its task counts as dropped.",
        "Wall time runs from the first planner or worker spawn to the final worker's completion.",
      ],
    };
  }

  /** `42m`, or `1h 5m` from an hour up; `—` for null. */
  function duration(ms: number | null) {
    if (ms === null) return "—";
    const minutes = Math.round(ms / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  function statsText(stats: ReturnType<typeof chiefStats>) {
    const { tasks, todos, repairs, failures, wallTimeMs, verdicts, research } = stats;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return [
      `Chief stats · ${stats.scope.chiefThreadId ? `Chief run ${stats.scope.chiefThreadId}` : `project ${stats.scope.projectId} (all Chief runs)`}`,
      `Tasks: ${tasks.total} — ${tasks.completed} completed, ${tasks.open} open, ${tasks.dropped} dropped · todos: ${todos.open} open, ${todos.done} done, ${todos.dropped} dropped`,
      `Task kinds: ${tasks.planned} planned, ${tasks.unplanned_planner_on} unplanned (planner on), ${tasks.unplanned_planner_off} unplanned (planner off), ${tasks.simple} simple, ${tasks.unknown} unknown`,
      `Reviews: ${verdicts.approve} approve, ${verdicts.request_changes} request_changes`,
      `Research: ${research.length ? research.map((entry) => `${entry.role} ${entry.mode ?? "resume"} ${entry.succeeded}/${entry.calls} succeeded`).join(", ") : "no calls"}`,
      `Repairs: ${plural(repairs.replacements, "replacement round")}, ${repairs.requestChanges} request_changes (${plural(repairs.regressions, "regression")}), ${plural(repairs.consults, "consult")}`,
      `Failures: provider ${failures.usageLimit + failures.connection} (usage limit ${failures.usageLimit}, connection ${failures.connection}) · timing ${failures.busyRejections + failures.stalls + failures.hardStalls} (busy rejections ${failures.busyRejections}, stalls ${failures.stalls}, hard stalls ${failures.hardStalls}) · rejected reviews ${failures.rejectedReviews} · thread errors ${failures.threadErrors}`,
      `Wall time (${wallTimeMs.completed} completed): median ${duration(wallTimeMs.median)}, total ${duration(wallTimeMs.total)}`,
      "Per task:",
      ...(stats.perTask.length ? stats.perTask.map((task) => {
        const failed = task.usageLimit + task.connection + task.threadErrors + task.busyRejections + task.stalls + task.hardStalls;
        return `- ${task.status} · ${task.title} · ${plural(task.workers, "worker")}, ${plural(task.replacements, "replacement")}, ${task.approvals} approve, ${task.requestChanges} request_changes, ${plural(task.consults, "consult")}, ${plural(failed, "failure")} · ${duration(task.wallTimeMs)}`;
      }) : ["- none"]),
      "Not measured:",
      ...stats.notes.map((note) => `- ${note}`),
    ].join("\n");
  }

  /** The Pending block, in the same wording as the lifecycle alert — "Pending: none."
   * when nothing is, so the block is never silently missing (an empty roster included). */
  function pendingLines(rows: ManagedRow[], todos: string[] = []): string[] {
    const pending = rows
      .map((row) => [row, nextAction(row)] as const)
      .filter((entry): entry is [ManagedRow, string] => entry[1] !== null)
      .map(([row, action]) => `- ${row.role} “${row.title}” (${row.thread_id}): ${action}`);
    return pending.length || todos.length ? ["Pending:", ...pending, ...todos] : ["Pending: none."];
  }

  /** Who owns a todo, seen by `viewer` (none = operator shell): "" for the viewer's own. */
  function todoOwnerLabel(todo: TodoRow, viewer?: string) {
    const owner = todo.chief_thread_id;
    if (!owner) return "unowned";
    if (owner === viewer) return "";
    return viewer && !isActiveChief(store.get(owner)) ? `ended Chief ${owner}` : `Chief ${owner}`;
  }

  function todoLine(todo: TodoRow, viewer?: string) {
    const state = todo.state === "open" ? "" : ` [${todo.state}]`;
    const label = todoOwnerLabel(todo, viewer);
    return `- todo #${todo.id}${label ? ` (${label})` : ""}${state}: ${todo.text}${todo.after ? ` (after: ${todo.after})` : ""}`;
  }

  /** A project's open todos as Pending lines — after thread lines, so clipping drops them first.
   * With `viewer`, the viewer's own todos come first and the rest follow under a header; without
   * one (operator shell) everything is one tagged list. With `collapseWaiting`, todos that wait
   * on an `after:` condition fold into one count line per group. */
  function todoLines(projectId: string | undefined, collapseWaiting = false, viewer?: string) {
    const todos = projectId ? (todosForProject.all(projectId) as TodoRow[]) : [];
    const group = (list: TodoRow[], noun: string) => {
      if (!collapseWaiting) return list.map((todo) => todoLine(todo, viewer));
      const waiting = list.filter((todo) => todo.after);
      const lines = list.filter((todo) => !todo.after).map((todo) => todoLine(todo, viewer));
      const n = waiting.length;
      if (n) lines.push(`- ${n} waiting ${noun}${n === 1 ? "" : "s"} (#${waiting.map((todo) => todo.id).join(", #")}) hidden: each waits on its after: condition. chief_roster includeWaiting: true lists them.`);
      return lines;
    };
    if (!viewer) return group(todos, "todo");
    const others = group(todos.filter((todo) => todo.chief_thread_id !== viewer), "other-Chief todo");
    return [
      ...group(todos.filter((todo) => todo.chief_thread_id === viewer), "todo"),
      ...(others.length ? ["Other Chiefs' todos (not your work; act on one only when the user asks):", ...others] : []),
    ];
  }

  /** Clips a rendered Pending block to `limit` by whole lines — never mid-action —
   * naming how many were dropped. Clipped on its own, separately from the rest of
   * the roster, so an overflowing roster still cuts detail rows first. */
  function clipPendingBlock(lines: string[], limit: number): string {
    const joined = lines.join("\n");
    if (joined.length <= limit) return joined;
    const [header, ...items] = lines;
    const kept: string[] = [];
    let used = header!.length;
    for (const item of items) {
      const next = used + 1 + item.length;
      if (next > limit) break;
      used = next;
      kept.push(item);
    }
    let suffix = `…and ${items.length - kept.length} more pending`;
    while (kept.length > 0 && used + 1 + suffix.length > limit) {
      used -= 1 + kept.pop()!.length;
      suffix = `…and ${items.length - kept.length} more pending`;
    }
    return [header, ...kept, suffix].join("\n");
  }

  /** The Pending block exactly as chief_roster prints it. */
  function pendingBlock(chiefThreadId: string, includeWaiting = false, limit = 6_000) {
    return clipPendingBlock(pendingLines([...rosterForChief(chiefThreadId)].filter((row) => row.thread_id !== chiefThreadId).reverse(), todoLines(store.get(chiefThreadId)?.project_id, !includeWaiting, chiefThreadId)), limit);
  }

  /** The panel's checklist: action threads, in-progress threads (newest first), open
   * todos, then done threads and closed todos by recency, capped at MAX_DONE_ITEMS. */
  function todoItems(chiefThreadId: string): { items: TodoItem[]; doneOmitted: number } {
    const rows = rosterForChief(chiefThreadId, true).filter((row) => row.thread_id !== chiefThreadId).reverse();
    const threadItem = (row: ManagedRow, done: boolean) => ({
      id: row.thread_id, label: `${row.role} “${row.title}”`, status: row.state, action: done ? null : nextAction(row), done,
    });
    const projectId = store.get(chiefThreadId)?.project_id;
    const todoItem = (todo: TodoRow) => {
      const owner = todoOwnerLabel(todo, chiefThreadId);
      return {
        id: `todo #${todo.id}`,
        label: `${todo.text}${todo.after ? ` (after: ${todo.after})` : ""}${owner ? ` — ${todo.chief_thread_id ? "from " : ""}${owner}` : ""}`,
        status: owner ? (todo.chief_thread_id ? "other Chief" : "unowned") : todo.state,
        action: null, done: todo.state !== "open",
      };
    };
    const openTodos = (projectId ? todosForProject.all(projectId) as TodoRow[] : []);
    const open = rows.filter(isOpenItem).map((row) => threadItem(row, false));
    const doneRows = [
      ...rows.filter((row) => !isOpenItem(row)).map((row) => [row.updated_at, threadItem(row, true)] as const),
      ...(projectId ? closedTodosForProject.all(projectId) as TodoRow[] : []).filter((todo) => todo.chief_thread_id === chiefThreadId).map((todo) => [todo.updated_at, todoItem(todo)] as const),
    ].sort((a, b) => b[0] - a[0]);
    return {
      items: [
        ...open.filter((item) => item.action),
        ...open.filter((item) => !item.action),
        ...openTodos.filter((todo) => todo.chief_thread_id === chiefThreadId).map(todoItem),
        ...openTodos.filter((todo) => todo.chief_thread_id !== chiefThreadId).map(todoItem),
        ...doneRows.slice(0, MAX_DONE_ITEMS).map(([, item]) => item),
      ],
      doneOmitted: Math.max(0, doneRows.length - MAX_DONE_ITEMS),
    };
  }

  /** Every active Chief's checklist, only to detect a change worth a realtime signal. */
  function pendingSnapshot() {
    return store.all().filter(isActiveChief).map((chief) => [chief.thread_id, todoItems(chief.thread_id)]);
  }

  async function lastOutput(threadId: string) {
    try {
      return (await bb.sdk.threads.output({ threadId })).output;
    } catch (error) {
      bb.log.warn(`Could not inspect output for ${threadId}: ${String(error)}`);
      return null;
    }
  }

  /** The worker's completed shell commands as BB recorded them (item/completed commandExecution),
   * last 20. null when the log cannot be read; [] when the provider records none. Never throws. */
  async function recordedCommands(threadId: string): Promise<RecordedCommand[] | null> {
    try {
      const commands: RecordedCommand[] = [];
      let beforeSeq: string | undefined;
      // The server rejects a page over 100 events (HTTP 400), which used to read as "none recorded".
      // ponytail: newest first, 5 pages of 100 events; commands older than that budget are not shown.
      for (let page = 0; page < 5 && commands.length < 20; page++) {
        const events = await bb.sdk.threads.events.list({ threadId, types: ["item/completed"], order: "desc", limit: "100", ...(beforeSeq ? { beforeSeq } : {}) });
        for (const event of events) {
          if (event.type !== "item/completed" || event.data.item.type !== "commandExecution") continue;
          const item = event.data.item;
          commands.push({ command: item.command, exitCode: item.exitCode ?? null, status: item.status });
          if (commands.length === 20) break;
        }
        if (events.length < 100) break;
        beforeSeq = String(events.at(-1)!.seq);
      }
      return commands.reverse();
    } catch (error) {
      bb.log.warn(`Could not read recorded commands for ${threadId}: ${String(error)}`);
      return null;
    }
  }

  async function lastProviderError(threadId: string) {
    try {
      const [event] = await bb.sdk.threads.events.list({ threadId, types: ["provider/error", "system/error"], order: "desc", limit: "1" });
      if (event?.type !== "provider/error" && event?.type !== "system/error") return null;
      const info = event.type === "provider/error" ? event.data.errorInfo : undefined;
      const text = [info?.category, info?.httpStatusCode, event.data.message, event.data.detail].filter(Boolean).join(" ");
      return { text, at: event.createdAt };
    } catch (error) {
      bb.log.warn(`Could not read the last provider error for ${threadId}: ${String(error)}`);
      return null;
    }
  }

  /** Records a usage-limit failure as a cooldown on the thread's provider+model. Never throws. */
  async function noteCooldown(threadId: string, failure: { text: string; at: number }) {
    const transient = transientFailure(failure.text);
    if (!transient?.usageLimit) return null;
    // The thread carries its provider; its execution options carry the model.
    let options: { providerId?: string; model?: string } | null = null;
    try {
      const [live, execution] = await Promise.all([bb.sdk.threads.get({ threadId }), bb.sdk.threads.defaultExecutionOptions({ threadId })]);
      options = { providerId: live?.providerId, model: execution?.model };
    } catch (error) {
      bb.log.warn(`Could not read the provider of ${threadId}: ${String(error)}`);
    }
    if (!options?.providerId) {
      bb.log.warn(`No provider known for ${threadId}; its usage limit is not recorded as a cooldown.`);
      return null;
    }
    if (!options.model) {
      bb.log.warn(`No model known for ${threadId}; its usage limit is not recorded as a cooldown.`);
      return null;
    }
    const until = failure.at + (transient.resetSeconds ?? 15 * 60) * 1000;
    upsertCooldown.run(options.providerId, options.model, until, clip(failure.text, 400), Date.now());
    return { providerId: options.providerId, model: options.model, until };
  }

  async function inspect(threadId: string, projectId: string) {
    const row = store.get(threadId);
    if (!row || row.project_id !== projectId) throw new Error(`No managed thread ${threadId} for this Chief project.`);
    let liveStatus = row.status;
    try {
      const live = await bb.sdk.threads.get({ threadId });
      liveStatus = live.deletedAt !== null ? "deleted" : live.archivedAt !== null ? "archived" : live.status;
    } catch (error) {
      bb.log.warn(`Could not inspect live status for ${threadId}: ${String(error)}`);
    }
    const output = await lastOutput(threadId);
    return [
      `Thread: ${row.title} (${threadId})`,
      `Role: ${row.role}`,
      ...(row.kind ? [`Kind: ${row.kind}`] : []),
      ...(row.branch ? [`Branch: ${row.branch}`] : []),
      ...(row.issue_url ? [`Issue: ${row.issue_url}`] : []),
      ...(row.pr_url ? [`Pull request: ${row.pr_url}`] : []),
      ...(row.unplanned_reason ? [`Unplanned: ${clip(row.unplanned_reason, 300)}`] : []),
      ...(row.review_skipped ? [`Review skipped: ${clip(row.review_skipped, 300)}`] : []),
      ...(row.tests_skipped ? [`Tests skipped: ${clip(row.tests_skipped, 300)}`] : []),
      ...(row.role === "planner" ? planWavesFor(threadId).flatMap((wave, index) => wave.testsSkipped ? [`wave ${index + 1}: tests skipped: ${clip(wave.testsSkipped, 300)}`] : []) : []),
      `Persisted state: ${row.state}`,
      `Live status: ${liveStatus ?? "unknown"}`,
      ...(row.summary ? [`Summary: ${row.summary}`] : []),
      ...(row.result ? [`Result: ${clip(row.result, 1_500)}`] : []),
      ...(row.blocker ? [`Blocker: ${clip(row.blocker, 600)}`] : []),
      ...(row.recommendation ? [`Recommendation: ${clip(row.recommendation, 600)}`] : []),
      ...(row.verdict ? [`Verdict: ${row.verdict}`] : []),
      ...(row.verdict_path ? [`Verdict file: ${row.verdict_path}`] : []),
      ...(row.report_path ? [`Full report (last chief_report): ${row.report_path}`] : []),
      `Last assistant output:\n${output ? clip(output, 2_000) : "(none available)"}`,
    ].join("\n");
  }

  const { research, researchSleep, checkUnreported } = createResearch({
    db, bb, managedRow, roleRow: store.get, terminal, isActiveChief, researchSettings, readResearchModel,
    environmentHostId, discover, catalogReader, usableSelection, anyCooldown, cooldownError, noteCooldown, lastProviderError,
    lastOutput, managedSpawn, alertChief, writeArtifact, serverPath, clip, execFileAsync,
    maxResultLength: MAX_RESULT_LENGTH,
  });

  let forgeRuns: Promise<unknown> = Promise.resolve();
  bb.agents.registerTool({
    name: "chief_forge_init",
    presentation: { label: { pending: "Running forge pre-flight…", completed: "Ran forge pre-flight" } },
    description: "Run the forge pre-flight for one task — tracking issue, task branch, draft pull request — before chief_delegate. Refused for a plan until its required advisor review resolves. Returns the values, or a script to run yourself when the server could not. The pull request body is the reviewer's whole brief: planned work carries the plan summary and wave contracts (planThreadId and wave); unplanned work must pass mission, successCriteria and constraints, the same text you will pass to chief_delegate.",
    parameters: z.object({
      title: z.string().trim().min(1).max(160).describe("The exact title this task will be delegated with."),
      base: z.string().trim().min(1).max(300).optional().describe("Branch to cut from and target the pull request at. Omit for the project default; name one only to stack deliberately on an open pull request. Stack only when this work builds on that pull request's changes; independent work gets its own PR on the default base."),
      body: z.string().trim().min(1).max(4_000).optional().describe("Short summary for the issue and pull request body."),
      planThreadId: z.string().optional().describe("For planned work: the planner thread the task's wave comes from. Give it with wave; the plan summary and the wave's contracts are added to the issue and pull request body."),
      wave: z.number().int().min(1).optional().describe("For planned work: the 1-based wave this task implements. Give it with planThreadId."),
      mission: z.string().trim().min(1).max(12_000).optional().describe("Required without planThreadId (unplanned work): the same mission you will pass to chief_delegate. It goes into the pull request body, which is the reviewer's whole brief."),
      successCriteria: z.string().trim().max(12_000).optional().describe("The same success criteria you will pass to chief_delegate, as text (one per line)."),
      constraints: z.string().trim().max(12_000).optional().describe("The same constraints you will pass to chief_delegate, as text (one per line)."),
    }),
    async execute({ planThreadId, wave, mission, successCriteria, constraints, ...params }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_forge_init requires an active registered Chief thread.");
      }
      if ((planThreadId === undefined) !== (wave === undefined)) {
        throw new Error("Pass planThreadId and wave together, or neither.");
      }
      if (planThreadId === undefined && !mission) {
        throw new Error("chief_forge_init without planThreadId requires mission (with successCriteria and constraints when you have them): the pull request body is the reviewer's whole brief. Pass the same text you will give chief_delegate.");
      }
      let body = params.body;
      // Sections the pull request alone must carry for the reviewer; each is clipped so the body stays bounded.
      const briefSections = [
        ...(mission ? ["## Mission", clip(mission, FORGE_BRIEF_SECTION_MAX)] : []),
        ...(successCriteria ? ["## Success criteria", clip(successCriteria, FORGE_BRIEF_SECTION_MAX)] : []),
        ...(constraints ? ["## Constraints", clip(constraints, FORGE_BRIEF_SECTION_MAX)] : []),
      ];
      if (planThreadId === undefined) body = [params.body ?? `Tracking work for ${params.title}.`, "", ...briefSections].join("\n");
      if (planThreadId !== undefined && wave !== undefined) {
        const planner = store.get(planThreadId);
        if (!planner || planner.role !== "planner" || !controlsThread(planner, caller.thread_id)) {
          throw new Error(`No managed planner ${planThreadId} for this Chief.`);
        }
        const reviewRefusal = planReviewRefusal(planner);
        if (reviewRefusal) throw new Error(reviewRefusal);
        const waves = planWavesFor(planThreadId);
        if (wave > waves.length) {
          throw new Error(`Wave ${wave} is out of range: planner ${planThreadId} scheduled ${waves.length} wave(s).`);
        }
        body = [
          params.body ?? `Tracking work for ${params.title}.`,
          ...(briefSections.length ? ["", ...briefSections] : []),
          "", `<details><summary>Plan — wave ${wave} of ${waves.length} (planner ${planThreadId})</summary>`,
          "", clip(planner.result ?? "", 1_500),
          "", "### Contracts to verify", clip(waves[wave - 1]!.contracts ?? "None listed.", 2_000),
          "</details>",
        ].join("\n");
      }
      // One tracking issue per plan: its title and body describe the plan, every wave's pull request tracks it.
      const planner = planThreadId ? store.get(planThreadId) : undefined;
      const planIssue = (): Partial<Parameters<typeof forgeInitScript>[0]> => {
        if (!planner) return {};
        const current = store.get(planner.thread_id)?.plan_issue_url;
        if (current) return { issueUrl: current };
        const waves = planWavesFor(planner.thread_id);
        return {
          issueTitle: planner.title.replace(/^Plan · /, ""),
          issueBody: sanitizeForge([
            "Chief tracks this plan here: one comment per task outcome, one pull request per wave.", "",
            clip(planner.result ?? "", 1_500), "", "### Waves",
            ...waves.map((entry, index) => `Wave ${index + 1}: ${entry.title ?? "no description"}${entry.dependsOn?.length ? ` · depends on ${entry.dependsOn.join(", ")}` : ""}${entry.design ? " · design" : ""}`),
          ].join("\n")),
        };
      };
      const first = forgeInitScript({ ...params, body, ...planIssue() });
      const { branch } = first;
      let script = first.script;
      const cwd = await projectPath(caller.project_id);
      let failure: string | null = null;
      if (cwd) {
        // ponytail: a remote-host project whose path also exists on the server would run against the wrong checkout; unlikely.
        try {
          // Runs for one plan are serialized, so the second wave's call sees the issue the first one made.
          const parse = (stdout: unknown) => {
            const found = String(stdout).match(/^CHIEF_FORGE (.*)$/gm)?.at(-1)?.slice("CHIEF_FORGE ".length);
            return { line: found, values: Object.fromEntries((found ?? "").split(" ").map((pair) => {
              const at = pair.indexOf("=");
              return [pair.slice(0, at), pair.slice(at + 1)];
            })) as Record<string, string> };
          };
          const run = forgeRuns.then(async () => {
            script = forgeInitScript({ ...params, body, ...planIssue() }).script;
            const out = await execFileAsync("sh", ["-c", script], {
              cwd, timeout: FORGE_SCRIPT_TIMEOUT_MS,
              env: { ...process.env, PATH: serverPath() },
            });
            // Recorded before the next wave's run starts, so that run reuses this issue.
            const { values } = parse(out.stdout);
            if (planner && values.branch && values.forge && values.issue_url) {
              store.setPlanIssueUrl(planner.thread_id, values.issue_url);
            }
            return out;
          });
          forgeRuns = run.catch(() => undefined);
          const { line, values } = parse((await run).stdout);
          if (line && values.branch && values.forge) {
            return `The forge pre-flight already ran in the project checkout: branch=${values.branch} base=${values.base ?? ""} issue_url=${values.issue_url ?? ""} pr_url=${values.pr_url ?? ""}. Pass branch, issueUrl and prUrl to chief_delegate, omitting whatever came back empty — an empty issue_url usually means the repository has issues disabled, not a failure. Do not run anything yourself.`;
          }
          failure = !line ? "no CHIEF_FORGE line" : !values.branch ? "the branch was not cut" : "no gh or glab found on the server";
        } catch (error) {
          failure = String(error);
        }
        failure = clip(failure, 200);
        bb.log.warn(`Server-side forge pre-flight fell back to Chief: ${failure}`);
      }
      return [
        ...(failure ? [`Running it on the server did not finish (${failure}), so run it yourself.`] : []),
        "Run this from the project checkout, verbatim. Every value is already substituted and quoted, every forge step is best-effort, and your own checkout never moves:",
        "", "```sh", script, "```", "",
        `The last line is CHIEF_FORGE branch=… base=… issue_url=… pr_url=…. Pass those to chief_delegate as branch, issueUrl and prUrl, omitting whatever came back empty — an empty issue_url usually means the repository has issues disabled, and an empty branch means the cut failed, so delegate without one and the worktree uses the project default. Neither is a failure to report as one. The branch will be ${branch}.`,
      ].join("\n");
    },
  });
  bb.agents.registerTool({
    name: "chief_delegate",
    presentation: { label: { pending: "Delegating work…", completed: "Delegated work" } },
    description: `Delegate one clearly titled unit of implementation work to a visible worker in its own managed worktree. See kind for Designer work. verifyCommand goes into the worker's brief as its own check. replaces: is refused after ${CONSULT_AFTER_REJECTIONS} consecutive request_changes on the task until a consult has given its advice (a ready or blocked report), and from ${STOP_AFTER_REJECTIONS} on unless userApprovedRound is set; the count follows the replaces: chain and every reviewer, and only an approve resets it. A plan with more than one wave or marked complex is refused until its one advisor review resolves (chief_consult planThreadId).`,
    parameters: delegateParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_delegate requires an active registered Chief thread.");
      }
      const result = await delegate(params, context.threadId);
      return `Started worker “${result.title}” in thread ${result.threadId}. Track it with chief_roster.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_plan",
    presentation: { label: { pending: "Starting planner…", completed: "Started planner" } },
    description: "Send one unit of work to a read-only planner. It proposes an implementation plan, split into waves; its ready alert names the exact next call. With revises, a fresh planner revises a plan whose one advisor review asked for changes; the revision is delegated with no second review.",
    parameters: planParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_plan requires an active registered Chief thread.");
      }
      const result = await startPlan(params, context.threadId);
      return `Started planner “${result.title}” in thread ${result.threadId}. Its ready alert lists the wave schedule and the exact next call.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_spawn",
    presentation: { label: { pending: "Starting new Chief…", completed: "Started new Chief" } },
    description: "Hand one task to a new Chief for this project when the user asks to do it in a new Chief. Pass a literal title, the user's request verbatim, and the context it needs (goal, evidence, linked threads, issues, PRs, branches, plan and verdict files, open decisions). todoId moves your own open todo to it. It never takes over your managed threads: hand over only a task with no unfinished worker — every worker on it complete (chief_stop and a ready report do not release a worker's branch); otherwise keep the task.",
    parameters: spawnParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_spawn requires an active registered Chief thread.");
      }
      // Validated before spawning, so a refused todo leaves no thread and no row.
      const todo = params.todoId === undefined ? undefined : todoById.get(params.todoId, caller.project_id) as TodoRow | undefined;
      if (params.todoId !== undefined && (!todo || todo.state !== "open" || todo.chief_thread_id !== caller.thread_id)) {
        throw new Error(`Todo #${params.todoId} is not one of your open todos; only your own open todo can move to a new Chief.`);
      }
      const handoff = {
        fromChiefThreadId: caller.thread_id,
        title: params.title,
        request: params.request,
        context: todo ? `${params.context}\n\nTodo #${todo.id}: ${todo.text}` : params.context,
      };
      const { threadId } = await createChief(caller.project_id, handoff);
      const lines = [`Started Chief “${params.title}” in thread ${threadId}. It owns this task now and is not your managed work: it is not in your roster, sends you no alerts, and you cannot inspect or steer it.`];
      if (todo) {
        // Check-and-set: the todo may have changed owner or state while the Chief was starting.
        const moved = db.prepare(`UPDATE chief_todos SET chief_thread_id=?, updated_at=? WHERE id=? AND project_id=? AND chief_thread_id=? AND state='open'`)
          .run(threadId, Date.now(), todo.id, caller.project_id, caller.thread_id).changes;
        store.reload();
        lines.push(moved ? `Todo #${todo.id} moved to it.` : `Todo #${todo.id} was not moved because it changed in the meantime.`);
      }
      // Not persistBrief: its failure only reaches the log, and this one must show in the calling Chief's turn.
      let error: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        try {
          await writeStorageFile(threadId, "brief.md", handoffSection(handoff));
          error = undefined;
          break;
        } catch (caught) { error = caught; }
      }
      if (error !== undefined) lines.push(`brief.md not saved (${String(error)}); the handoff is only in its first message.`);
      return lines.join("\n");
    },
  });
  bb.agents.registerTool({
    name: "chief_consult",
    presentation: { label: { pending: "Starting advisor…", completed: "Started advisor" } },
    description: "Start a read-only advisor on a hard problem or a change that keeps failing review. It may read code and run commands to reproduce it, never edits, and reports its advice back to you. With planThreadId, it gives a multi-wave or complex plan its one review before delegation; refused for any other plan.",
    parameters: consultParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) {
        throw new Error("chief_consult requires an active registered Chief thread.");
      }
      if (params.workerThreadId) {
        await controlledTarget(params.workerThreadId, caller);
      }
      touchCallerChief(caller);
      const result = await startConsult(params, context.threadId);
      return `Started advisor “${result.title}” in thread ${result.threadId}. Wait for its advice before starting another worker round.`;
    },
  });
  function touchCallerChief(caller?: ManagedRow) {
    if (caller && caller.role === "chief" && caller.state === "failed") {
      store.reactivate(caller.thread_id);
    }
  }

  bb.agents.registerTool({
    name: "chief_roster",
    presentation: { label: { pending: "Reading roster…", completed: "Read roster" } },
    description: "Inspect this project's managed threads and their bounded persisted status, result, blocker, and recommendation. Opens with a Pending block naming each item's next action, in the same wording as its lifecycle alert. Add a todo with `todo.text` (and optional `after`, e.g. 'PR #42 merges'); change one by `todo.id`; close it with `state: done|dropped`. Track all Chief work here — including queued work nobody has delegated yet. Todos with an after: condition are summarised as one line; pass includeWaiting: true to list them. Each todo belongs to the Chief that added it; others' todos are listed apart and tagged — leave them unless the user asks.",
    parameters: z.object({
      includeComplete: z.boolean().optional(),
      includeWaiting: z.boolean().optional().describe("List todos that wait on an after: condition in full; by default the Pending block shows them as one count line."),
      todo: z.object({
        id: z.number().int().optional(),
        text: z.string().trim().min(1).max(500).optional(),
        after: z.string().trim().max(200).optional().describe("Empty string clears it."),
        state: z.enum(["open", "done", "dropped"]).optional(),
      }).optional(),
    }),
    async execute({ includeComplete, includeWaiting, todo }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error("chief_roster requires an active registered Chief thread.");
      touchCallerChief(caller);
      let note = "";
      if (todo) {
        const now = Date.now();
        if (todo.id === undefined) {
          if (!todo.text) throw new Error("chief_roster todo needs text to add, or an id to change.");
          insertTodo.run(caller.project_id, caller.thread_id, todo.text, todo.after || null, now, now);
        } else {
          const existing = todoById.get(todo.id, caller.project_id) as TodoRow | undefined;
          if (!existing) throw new Error(`No todo #${todo.id} in this project.`);
          const after = todo.after === undefined ? existing.after : todo.after || null;
          updateTodo.run(todo.text ?? existing.text, after, todo.state ?? existing.state, now, todo.id, caller.project_id);
          if (existing.chief_thread_id && existing.chief_thread_id !== caller.thread_id && isActiveChief(store.get(existing.chief_thread_id))) {
            note = `Note: todo #${existing.id} belongs to Chief ${existing.chief_thread_id}; change it only when the user asks.\n`;
          }
        }
        store.reload();
      }
      const rows = rosterForChief(caller.thread_id, includeComplete);
      const reversed = [...rows].reverse();
      // The Pending block is clipped on its own so it always survives whole (or
      // ends with "…and N more pending"), then the rest gets whatever budget is
      // left — otherwise one clip() across both could cut a pending action off mid-line.
      const pending = note + pendingBlock(caller.thread_id, includeWaiting, 6_000 - note.length);
      const room = 6_000 - pending.length - 1;
      // clip() with a limit of 0 or less returns the whole string, so a full Pending block drops the rest.
      if (room <= 0) return pending;
      const rest = clip([
        ...reversed.map((row) => rosterRowLines(row).join("\n  ")),
        ...(includeComplete ? (closedTodosForProject.all(caller.project_id) as TodoRow[]).map((todo) => todoLine(todo, caller.thread_id)) : []),
      ].join("\n"), room);
      return `${pending}\n${rest}`;
    },
  });
  bb.agents.registerTool({
    name: "chief_inspect",
    presentation: { label: { pending: "Inspecting thread…", completed: "Inspected thread" } },
    description: "Inspect one managed thread's live status, persisted report summary, full-report file path, and bounded last assistant output before deciding what to do.",
    parameters: z.object({ threadId: z.string() }),
    async execute({ threadId }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      const target = await resolveTarget(threadId, caller.thread_id);
      if (!target || !belongsToChief(target, caller.thread_id)) {
        throw new Error(`No managed thread ${threadId} for this Chief.`);
      }
      touchCallerChief(caller);
      return inspect(threadId, caller.project_id);
    },
  });
  bb.agents.registerTool({
    name: "chief_continue",
    presentation: { label: { pending: "Nudging thread…", completed: "Nudged thread" } },
    description: `Send a short nudge (at most ${MAX_NUDGE_LENGTH} characters) to a managed thread that is still working. Refused for any thread that has reported (ready or complete); follow-up work goes to a fresh worker, planner, reviewer, advisor or researcher (see the core rules).`,
    parameters: z.object({
      threadId: z.string(),
      instruction: z.string().trim().min(1).max(MAX_NUDGE_LENGTH).describe(`A short nudge, at most ${MAX_NUDGE_LENGTH} characters.`),
    }),
    async execute({ threadId, instruction }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      await controlledTarget(threadId, caller);
      touchCallerChief(caller);
      const capped = await continueThread(threadId, instruction, caller.thread_id);
      return `Continued ${threadId}.${capped ? stallCapNote : ""}`;
    },
  });
  bb.agents.registerTool({
    name: "chief_stop",
    presentation: { label: { pending: "Stopping thread…", completed: "Stopped thread" } },
    description: "Interrupt a running managed thread that is stuck or looping. Keeps its worktree, branch, and history; the reply names the reroute steps.",
    parameters: stopParams,
    async execute({ threadId, reason }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error("chief_stop requires an active registered Chief thread.");
      await controlledTarget(threadId, caller);
      touchCallerChief(caller);
      const row = await stopThread(threadId, reason);
      return `Stopped “${row.title}” (${threadId}). Its worktree, branch, and history are kept. ${rerouteSteps(row)}`;
    },
  });
  bb.agents.registerTool({
    name: "chief_review",
    presentation: { label: { pending: "Starting review…", completed: "Started review" } },
    description: "Only the active Chief starts reviews; the server refuses every other caller. Start or return an independent read-only review: for a worker with no plan link, in its existing worktree; for a plan worker, ONE review of the whole plan covering the latest worker of every branch, each pull request pinned to its own head commit. It is refused for an intermediate wave, a superseded worker, a design wave, and while any wave of the plan is not ready. With no worker, it reviews a pull request or branch in a fresh worktree; a branch a managed worker carries is refused (review that worker).",
    parameters: reviewParams,
    async execute(params, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      requireChiefCaller(caller, "chief_review");
      if (params.workerThreadId) {
        await controlledTarget(params.workerThreadId, caller);
        touchCallerChief(caller);
        const review = await startReview(caller, params.workerThreadId, params.focus);
        const sliceNote = review.sliceSkipped?.length ? ` Impact slice skipped: ${review.sliceSkipped.join("; ")}.` : "";
        const scopeNote = review.scope?.length ? ` Review scope: ${review.scope.join("; ")}.` : "";
        return `${review.created ? "Started" : "Using existing"} “${review.title}” in thread ${review.threadId}. ${reviewPathNote(params.workerThreadId, review.pinnedSha, review.covers)}${sliceNote}${scopeNote}`;
      }
      touchCallerChief(caller);
      const branch = params.branch
        ?? (await resolvePullRequestBranch(params.pullRequest!, await projectPath(caller.project_id)))
        ?? params.pullRequest!;
      const review = await startBranchReview(caller, branch, params.pullRequest ?? null, params.focus);
      return `${review.created ? "Started" : "Using existing"} “${review.title}” in thread ${review.threadId}.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_complete",
    presentation: { label: { pending: "Completing work…", completed: "Completed work" } },
    description: "Mark an idle managed worker or reviewer complete after Chief has inspected sufficient evidence. Completing a worker also completes its reviewers and the advisors consulted on it, and — after the plan's final wave — its planner. A worker completed with an approving review (or a design wave with the owner's approval) while the cleanupApproved setting is on is then cleaned up by a background cleanup worker: it archives the task's threads when nothing else would be archived with them, deletes their bb/ worktree branches after bb removes the worktree and only when origin holds every commit, and clears their thread storage unless Chief's evidence is stored there; override and skipReview completions are never cleaned up. A design-only wave's worker completes only with the owner's approval recorded by chief_owner_approval. Any other worker with a pull request completes only when the newest review is an approve for the pull request's current head commit (a worker without one: for its current report); otherwise it is refused naming the reason. override (a reason) is the only bypass and is recorded in the result. skipReview (your reason) completes a worker without any review when you judge one unnecessary. After a worker completes, this call marks its draft pull request ready for review: never run gh pr ready or glab mr update --ready yourself for a worker's pull request.",
    parameters: z.object({ threadId: z.string(), result: z.string().trim().max(MAX_RESULT_LENGTH).optional(), override: overrideSchema.describe("Complete a worker even though no approve covers its pull request head (or current report). The reason is recorded in its result. Use only when the user or the evidence justifies skipping the review."),
      skipReview: overrideSchema.describe("Complete a worker without a review, by your own judgment: your reason, shown in chief_roster, chief_inspect and on the pull request. Refused only while a review of the task is running, without a ready report, on a design wave (needs chief_owner_approval), or together with override. Never cleaned up."),
      testsSkipped: overrideSchema.describe("Your reason for completing unplanned work with no tester: an unplanned worker whose task chain has no tester is refused without it. Shown in chief_roster, chief_inspect and on the pull request. A plan's test wave is waived with chief_skip_tests instead.") }),
    async execute({ threadId, result, override, skipReview, testsSkipped }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      await controlledTarget(threadId, caller);
      touchCallerChief(caller);
      const { row, overridden, skipped, cleanup } = await markComplete(threadId, result, override, skipReview, testsSkipped);
      const ready = await readyPullRequest(row);
      const todos = row.role === "worker" ? (todosForProject.all(caller.project_id) as TodoRow[]).filter((todo) => todo.chief_thread_id === caller.thread_id) : [];
      const todoLine = todos.length
        ? `\n${clip(`Open todos: ${todos.map((todo) => `#${todo.id} ${clip(todo.text, 80)}`).join(", ")} — close any this work finished with chief_roster todo { id, state: "done" }.`, 1_000)}`
        : "";
      return `Marked “${row.title}” complete${overridden ? ` without a matching approve (override recorded in its result)` : skipped ? " without a review (reason recorded)" : ""}.${ready.line}${cleanupLine(cleanup)}${todoLine}`;
    },
  });
  bb.agents.registerTool({
    name: "chief_owner_approval",
    presentation: { label: { pending: "Recording approval…", completed: "Recorded approval" } },
    description: "Record the owner's approval of a design-only wave (a plan wave marked design: true). Only the owner approves design-only work; chief_review refuses it. Show the user the artboards from the designer's ready report, ask for explicit approval, then call this with their words verbatim. The wave that implements the artboards cannot be delegated, and the design wave cannot be completed, without it. A new report or chief_continue on the designer clears it. Refused for any other thread.",
    parameters: z.object({
      workerThreadId: z.string(),
      approval: z.string().trim().min(1).max(2_000).describe("The user's own words approving the artboards, verbatim."),
    }),
    async execute({ workerThreadId, approval }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed worker ${workerThreadId} for this Chief.`);
      const target = await controlledTarget(workerThreadId, caller);
      touchCallerChief(caller);
      return recordOwnerApproval(target, approval);
    },
  });
  bb.agents.registerTool({
    name: "chief_skip_tests",
    presentation: { label: { pending: "Waiving tests…", completed: "Waived tests" } },
    description: "Go without a plan's test wave (test: true), by your own judgment: your reason is recorded on that wave and shown in chief_roster and chief_inspect. Before the wave is delegated, the wave drops out of the plan and its parent's worker ends the chain. After a tester ran on it, that tester stays the branch owner and you review or complete it (a blocked report counts). Refused while the wave's latest worker is running, once it is complete, or for a wave that is not a test wave. Calling it again changes nothing.",
    parameters: z.object({ planThreadId: z.string(), wave: z.number().int().min(1).max(MAX_WAVES), reason: overrideSchema.describe("Why this plan goes without that wave's tests.") }),
    async execute({ planThreadId, wave, reason }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      const planner = store.get(planThreadId);
      if (!planner || planner.role !== "planner" || !controlsThread(planner, caller.thread_id)) throw new Error(`No managed planner ${planThreadId} for this Chief.`);
      if (!reason) throw new Error("reason is required: why this plan goes without that wave's tests.");
      touchCallerChief(caller);
      const refusal = planReviewRefusal(planner);
      if (refusal) throw new Error(refusal);
      const waves = planWavesFor(planThreadId);
      if (!waves[wave - 1]?.test) throw new Error(`Wave ${wave} of planner ${planThreadId} is not a test wave (test: true).`);
      const latest = waveWorkers(planThreadId, wave).at(-1);
      if (latest) {
        if (latest.state === "complete") throw new Error(`Wave ${wave}'s worker ${latest.thread_id} is complete: nothing left to waive.`);
        const live = await bb.sdk.threads.get({ threadId: latest.thread_id });
        if (BUSY_STATUSES.has(live.status)) throw new Error(`Wave ${wave}'s worker ${latest.thread_id} is ${live.status}: wait until it is idle, then waive.`);
      }
      if (!waves[wave - 1]!.testsSkipped) store.skipTestWave(planThreadId, wave, reason);
      if (latest) return waivedLine(latest);
      const parent = parentOf(waves, wave);
      const owner = parent !== null ? waveWorkers(planThreadId, parent).at(-1) : undefined;
      const next = owner?.state === "ready" ? workerReadyNextStep(owner, true) : null;
      return next ?? `Wave ${parent} has not reported ready yet; its ready alert names the next call.`;
    },
  });
  bb.agents.registerTool({
    name: "chief_escalate",
    presentation: { label: { pending: "Posting escalation…", completed: "Posted escalation" } },
    description: "Before you write a **Need you** request in chat, post it on the managed thread's pull request (else its tracking issue) with an @mention of the owner, so it is on record where the work is. threadId is the managed thread the request concerns; request is the full request. It returns at once; the post happens in the background. A planner with no tracking issue yet returns \"chat only\": then write the request in chat alone. Calling it again with the same request posts nothing new.",
    parameters: z.object({
      threadId: z.string(),
      request: z.string().trim().min(1).max(12_000).describe("The full request, as you will write it in chat under Need you."),
    }),
    async execute({ threadId, request }, context) {
      const caller = context.threadId ? store.get(context.threadId) : undefined;
      if (!isActiveChief(caller)) throw new Error(`No managed thread ${threadId} for this Chief.`);
      const concerned = await controlledTarget(threadId, caller);
      touchCallerChief(caller);
      const chatOnly = "No pull request or issue to post on; write the request in chat only.";
      const url = concerned.pr_url ?? concerned.issue_url
        ?? (concerned.role === "reviewer" ? ledger.targets(concerned.thread_id).map((target) => target.pr_url ?? store.get(target.worker_thread_id)?.pr_url).find(Boolean) : undefined)
        ?? (concerned.role === "planner" ? concerned.plan_issue_url : undefined);
      if (!url) return chatOnly;
      const id = `escalate:${threadId}:${createHash("sha1").update(request).digest("hex").slice(0, 12)}`;
      const queued = enqueueForgeComment({
        key: id, row: concerned, target: url, mention: true,
        body: composeComment({ key: id, title: "Need you", lines: [forgeText(request, 12_000)] }),
      });
      return queued ? `Queued for ${url}. Now write the same request in chat under **Need you**.` : chatOnly;
    },
  });
  bb.agents.registerTool({
    name: "chief_report",
    presentation: { label: { pending: "Reporting to Chief…", completed: "Reported to Chief" } },
    description: "Report managed work state and evidence to Chief. Use ready, not complete; blocked requires blocker and recommendation; a reviewer's ready report requires a verdict and findings; a planner's ready report requires plan (the full plan body), which Chief receives as a file, and may set complex; a plan review's ready report requires a verdict. Send a short `summary` with a long `result`; the full result is saved to a per-report file. Any length of result is accepted; an invalid report is refused with one line per field to fix.",
    parameters: reportParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_report requires a thread context.");
      const delivered = await report(context.threadId, params, context.projectId);
      return delivered ? "Report delivered to Chief." : "Report queued for Chief; it will be delivered automatically. Do not report again.";
    },
  });

  bb.agents.registerTool({
    name: "chief_log",
    presentation: { label: { pending: "Reading plan log…", completed: "Read plan log" } },
    description: "Plan workers only: append FACT/FAIL notes for peer waves, and read unread peer notes plus every wave's current worker and state. Never alerts Chief or changes your state.",
    parameters: logParams,
    async execute({ entries }, context) {
      const row = context.threadId ? store.get(context.threadId) : undefined;
      if (!row || row.role !== "worker" || !row.plan_thread_id) return "Not part of a plan run.";
      return planLog(row, entries);
    },
  });

  bb.agents.registerTool({
    name: "chief_research",
    presentation: { label: { pending: "Researching…", completed: "Researched" } },
    description: [
      "Fan a read-only question out to parallel BB workflow agents. survey: answer `question` for each of `items` (files, symbols, topics), one verified row each with evidence.",
      "investigate: one agent per `questions` entry, then one merges the answers into a brief with Confirmed and Unconfirmed sections.",
      "Chief, planners and researchers may use survey and investigate. Reviewers, workers and advisors cannot use it.",
      "Read-only by prompt only: the agents share your checkout and permissions, and are told not to edit, commit, or push.",
      "From Chief the call returns at once with the id of a researcher thread that runs the research in your checkout and reports through chief_report; its report arrives as a lifecycle alert, so end your turn instead of polling.",
      "From a planner, each call waits up to the mode's timeout (10 minutes unless set in Chief researcher settings), and never more than 2.5 minutes, because some providers end tool calls at 3 minutes. If the run is still going it returns its runId: call chief_research again with the same mode and that runId to keep waiting; the run keeps going in between.",
    ].join(" "),
    parameters: researchParams,
    async execute(params, context) {
      if (!context.threadId) throw new Error("chief_research requires a thread context.");
      return research(params, context);
    },
  });

  bb.agents.configure((context) => {
    const row = store.get(context.thread.id);
    if (row && ["complete", "archived", "deleted"].includes(row.state)) return { tools: [], skills: [] };
    // insertThread only runs after threads.spawn resolves, so the very first
    // configure() call for a brand-new thread can land before that row exists. The
    // role and chief seeded into pluginMetadata at spawn time cover that gap —
    // without it, a fast environment (a reused reviewer worktree wins this race far
    // more often than a freshly provisioned one) could start a thread with no tools
    // at all, including chief_report. pluginMetadata itself is writable by any API
    // client, another plugin, or the thread's own agent, so only trust it when
    // origin.pluginId proves this thread was actually created by our own spawn call
    // (seeding pluginMetadata always attributes the new thread to this plugin).
    const seeded = context.origin.pluginId === bb.pluginId
      ? spawnMetadataSchema.safeParse(context.pluginMetadata)
      : undefined;
    const role = row?.role ?? (seeded?.success ? seeded.data.role : undefined);
    if (!role) return { tools: [], skills: [] };
    const rules = rulesCache.get(context.project.id) ?? BUILT_IN_RULES;
    const research = researchLine(role, researchActive);
    // A researcher's brief says how to use chief_research, so it has no line but still needs the tool while research is on.
    const researchTool = !!research || (role === "researcher" && !!researchActive?.enabled);
    if (role === "chief") {
      return {
        tools: [
          ...(plannerActive ? ["chief_plan"] : []),
          "chief_consult", "chief_spawn",
          "chief_forge_init", "chief_delegate", "chief_roster", "chief_inspect", "chief_continue", "chief_stop", "chief_review", "chief_complete", "chief_owner_approval", "chief_skip_tests", "chief_escalate",
          ...(researchTool ? ["chief_research"] : []),
        ],
        skills: ["chief"],
        instructions: [
          `You are the registered Chief supervisor for ${context.project.name}. Use ordinary visible BB threads and drive managed work through completion.`,
          "",
          ROSTER_CHIEF_INSTRUCTIONS,
          WAIT_CHIEF_INSTRUCTIONS,
          ...(plannerActive ? ["", PLANNER_CHIEF_INSTRUCTIONS] : []),
          ...(research ? ["", research, researchChiefInstructions(plannerActive)] : []),
          "",
          rules,
          "",
          CHIEF_CORE_RULES,
        ].join("\n"),
      };
    }
    const chiefThreadId = row?.chief_thread_id ?? (seeded?.success ? seeded.data.chiefThreadId ?? null : null);
    // The newest 10 lessons, shown oldest first and clipped; better-sqlite3 is synchronous, so configure stays so.
    const newestLessons = (roleClause: string) => (db.prepare(`SELECT text FROM chief_lessons WHERE project_id=? AND ${roleClause} ORDER BY at DESC, id DESC LIMIT 10`).all(context.project.id) as { text: string }[]).reverse();
    const lessons = newestLessons(`(role IS NULL OR role='advisor')`);
    const reviewLessons = role === "reviewer" ? newestLessons(`role='reviewer'`) : [];
    // BUILT_IN_RULES are Chief's own (continue, complete, chief_review), so a managed thread
    // gets only a project's chief.md; its brief and the chief-worker skills cover the rest.
    return {
      tools: ["chief_report", ...(role === "worker" && (row?.plan_thread_id ?? (seeded?.success ? seeded.data.planThreadId : undefined)) ? ["chief_log"] : []), ...(researchTool ? ["chief_research"] : [])],
      // A designer is a worker row with kind "designer"; seeded metadata covers the pre-insertThread race.
      skills: managedSkills(role, row?.kind ?? (seeded?.success ? seeded.data.kind : undefined)),
      instructions: [
        `You are a managed ${role} reporting to Chief thread ${chiefThreadId}. chief_report: follow the chief-worker skill's report contract; after reporting, end with one line.`,
        "After any context compaction, before acting, re-read your full brief at $BB_THREAD_STORAGE/brief.md and every plan, verdict or report file it names.",
        ...(research ? [research] : []),
        ...(rules === BUILT_IN_RULES ? [] : ["", rules]),
        ...(lessons.length ? ["", clip(["## Lessons from earlier review rounds", ...lessons.map((lesson) => `- ${lesson.text}`)].join("\n"), 3_000)] : []),
        ...(reviewLessons.length ? ["", clip(["## Review lessons (known false positives and checks)", ...reviewLessons.map((lesson) => `- ${lesson.text}`)].join("\n"), 3_000)] : []),
      ].join("\n"),
    };
  });

  bb.rpc.register(rpcContract, {
    status: () => ({ sectionId: storedSectionId(), threads: store.all().map(toManaged) }),
    start: ({ projectId }) => ensureChief(projectId ?? undefined),
    create: ({ projectId }) => createChief(projectId),
    // The header badge asks for one thread's role on every thread it renders on: not the roster.
    role: ({ threadId }) => ({ role: store.get(threadId)?.role ?? null }),
    pending: ({ threadId }) =>
      isActiveChief(store.get(threadId)) ? { chief: true, ...todoItems(threadId) } : { chief: false, items: [], doneOmitted: 0 },
    modelConfiguration: async () => ({
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          chief: readRoleModel(host.id, "chief"),
          planner: readRoleModel(host.id, "planner"),
          worker: readRoleModel(host.id, "worker"),
          designer: readRoleModel(host.id, "designer"),
          reviewer: readRoleModel(host.id, "reviewer"),
          advisor: readRoleModel(host.id, "advisor"),
        };
        // A connected machine can answer for its own picks, so say which ones it
        // would refuse instead of showing a model the next spawn will ignore.
        // One reader for the whole host: roles sharing a provider scan it once.
        const read = catalogReader(host.id);
        const [scan, flagged] = await Promise.all([
          connected
            ? hostFallback(host.id, read)
            : { fallback: null, error: "Machine is disconnected; its model catalog is unavailable." },
          Promise.all(modelRoleSchema.options.map(async (role) => {
            const selection = selections[role];
            if (!connected || !selection) return null;
            return (await usableSelection(host.id, selection, read)) ? null : role;
          })),
        ]);
        return {
          hostId: host.id,
          hostName: host.name,
          connected,
          ...scan,
          selections,
          unusable: flagged.filter((role): role is ModelRole => role !== null),
        };
      })),
    }),
    researchConfiguration: async () => ({
      settings: await researchSettings(),
      hosts: await Promise.all((await bb.sdk.hosts.list()).map(async (host) => {
        const connected = host.status === "connected";
        const selections = {
          survey: readResearchModel(host.id, "survey"),
          investigate: readResearchModel(host.id, "investigate"),
        };
        // One reader for the whole host: modes sharing a provider scan it once.
        const read = catalogReader(host.id);
        const [scan, flagged] = await Promise.all([
          connected
            ? hostFallback(host.id, read)
            : { fallback: null, error: "Machine is disconnected; its model catalog is unavailable." },
          Promise.all(researchModeSchema.options.map(async (mode) => {
            const selection = selections[mode];
            if (!connected || !selection) return null;
            return (await usableSelection(host.id, selection, read)) ? null : mode;
          })),
        ]);
        return {
          hostId: host.id,
          hostName: host.name,
          connected,
          ...scan,
          selections,
          unusable: flagged.filter((mode): mode is ResearchMode => mode !== null),
        };
      })),
    }),
    setResearchModel: ({ hostId, mode, selection }) => {
      writeResearchModel(hostId, mode, selection);
      return { ok: true as const };
    },
    setResearchSettings: async (patch) => {
      const values: Record<string, boolean | number> = {};
      if (patch.enabled !== undefined) values.researchEnabled = patch.enabled;
      if (patch.maxAgentCalls !== undefined) values.researchMaxAgentCalls = patch.maxAgentCalls;
      const timeouts = patch.timeoutMinutes ?? {};
      if (timeouts.survey !== undefined) values.researchSurveyTimeoutMinutes = timeouts.survey;
      if (timeouts.investigate !== undefined) values.researchInvestigateTimeoutMinutes = timeouts.investigate;
      researchActive = researchFrom(await settings.experimental_set(values));
      return researchActive;
    },
    setRoleModel: ({ hostId, role, selection }) => {
      writeRoleModel(hostId, role, selection);
      return { ok: true as const };
    },
  });

  const usage = [
    "Usage:",
    "  bb chief status [--project proj_id] [--json]",
    "  bb chief stats [--project proj_id] [--chief thr_id] [--json]",
    "  bb chief start [--project proj_id] [--json]",
    "  bb chief create [--project proj_id] [--json]",
    "  bb chief adopt --thread thr_id [--json]",
    "  bb chief plan --title \"…\" --mission \"…\" [--context \"…\"] [--revises thr_id] [--json]",
    "  bb chief consult --title \"…\" --mission \"…\" [--context \"…\"] [--worker thr_id | --plan-thread thr_id] [--json]",
    "  bb chief delegate --title \"…\" --mission \"…\" [--criteria \"…\"]... [--constraint \"…\"]... [--context \"…\"] [--branch feature/…] [--issue-url …] [--pr-url …] [--replaces thr_id] [--plan-thread thr_id --wave N] [--unplanned-reason \"…\"] [--verify \"cmd\"] [--kind worker|designer|tester] [--json]",
    "  bb chief inspect <thread-id>",
    "  bb chief continue <thread-id> --instruction \"…\" [--json]",
    "  bb chief stop <thread-id> [--reason \"…\"] [--json]",
    "  bb chief complete <thread-id> [--result \"…\"] [--override \"reason\"] [--json]",
  ].join("\n");


  bb.cli.register({
    name: "chief",
    summary: "Supervise visible BB worker and review threads through completion",
    commands: [
      { name: "status", summary: "Show a project's Chief-managed roster", usage: "bb chief status [--project proj_id] [--json]" },
      { name: "stats", summary: "Summarise a project's or Chief run's reliability: tasks, repairs, failures, wall time", usage: "bb chief stats [--project proj_id] [--chief thr_id] [--json]" },
      { name: "start", summary: "Start or return the latest Chief for a project", usage: "bb chief start [--project proj_id] [--json]" },
      { name: "create", summary: "Create another Chief for a project", usage: "bb chief create [--project proj_id] [--json]" },
      { name: "adopt", summary: "Adopt an existing ordinary thread as its project's Chief", usage: "bb chief adopt --thread thr_id [--json]" },
      { name: "plan", summary: "Start a read-only planner for work Chief has not delegated yet", usage: "bb chief plan --title \"…\" --mission \"…\" [--revises thr_id] [--json]" },
      { name: "consult", summary: "Start a read-only advisor on a hard problem or a change that keeps failing review", usage: "bb chief consult --title \"…\" --mission \"…\" [--worker thr_id | --plan-thread thr_id] [--json]" },
      { name: "delegate", summary: "Start a clearly titled worker in a managed worktree", usage: "bb chief delegate --title \"…\" --mission \"…\" [--branch feature/…] [--issue-url …] [--pr-url …] [--replaces thr_id] [--plan-thread thr_id --wave N] [--unplanned-reason \"…\"] [--verify \"cmd\"] [--kind worker|designer|tester] [--json]" },
      { name: "inspect", summary: "Inspect a managed thread's live and reported evidence", usage: "bb chief inspect <thread-id>" },
      { name: "continue", summary: "Nudge a managed thread that is still working", usage: "bb chief continue <thread-id> --instruction \"…\" [--json]" },
      { name: "stop", summary: "Interrupt a stuck managed thread, keeping its worktree for a replacement", usage: "bb chief stop <thread-id> [--reason \"…\"] [--json]" },
      { name: "complete", summary: "Mark verified, non-running managed work complete", usage: "bb chief complete <thread-id> [--result \"…\"] [--override \"reason\"] [--json]" },
    ],
    async run(argv: string[], context: PluginCliContext): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      const args = parseArgs(rest);
      const json = args.bool("json");
      const ok = (data: unknown, text: string) => ({ exitCode: 0, stdout: clip(json ? JSON.stringify(data, null, 2) : text, 64_000) + "\n" });
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n\n${usage}\n` });
      try {
        if (!command || command === "help" || command === "--help") return ok({}, usage);
        // The CLI cannot prove who is calling (BB_THREAD_ID is only forwarded), so no caller may start a review from it.
        if (command === "review") return fail("bb chief review is retired: only the active Chief starts reviews, through its chief_review tool. Ask Chief in its thread.");
        // The agent tools refuse anyone but the active Chief; the CLI is the same door from a
        // shell. A user's own shell or thread (no managed row) stays trusted.
        const caller = context.threadId ? store.get(context.threadId) : undefined;
        const callerRole = caller?.role;
        if (caller && !isActiveChief(caller) && command !== "status" && command !== "inspect") {
          return fail(`bb chief ${command} is for the active Chief only${callerRole === "chief" ? "" : `; a managed ${callerRole} reports with chief_report`}.`);
        }
        // A managed Chief reads only its own roster; an operator shell keeps the project-wide view.
        const readScope = isActiveChief(caller) ? caller.thread_id : undefined;
        const readProject = caller?.project_id ?? context.projectId;
        // A managed Chief acts only on its directly owned work; an operator shell stays unscoped.
        const scoped = async (id: string) => {
          if (caller) await controlledTarget(id, caller);
        };
        if (command === "status") {
          const projectId = readScope ? readProject : args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("status requires --project outside a project thread");
          const managedRows = readScope ? rosterForChief(readScope, true) : rosterFor(projectId, true);
          const text = [
            ...pendingLines(readScope ? managedRows.filter((row) => row.thread_id !== readScope) : managedRows, todoLines(projectId, false, readScope)),
            ...managedRows.map((row) => rosterRowLines(row).join("\n  ")),
          ].join("\n");
          return ok({ sectionId: storedSectionId(), threads: managedRows.map(toManaged) }, text);
        }
        if (command === "stats") {
          const chiefId = readScope ?? args.one("chief");
          const chief = chiefId ? store.get(chiefId) : undefined;
          if (chiefId && chief?.role !== "chief") return fail(`No Chief thread ${chiefId}.`);
          const projectId = chief?.project_id ?? args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("stats requires --project outside a project thread");
          const todos = ([...todosForProject.all(projectId), ...closedTodosForProject.all(projectId)] as TodoRow[]).filter((todo) => !chiefId || todo.chief_thread_id === chiefId);
          const stats = chiefStats({ projectId, chiefThreadId: chiefId ?? null }, chiefId ? rosterForChief(chiefId, true) : rosterFor(projectId, true), todos);
          return ok(stats, statsText(stats));
        }
        if (command === "start") {
          const result = await ensureChief(args.one("project") ?? context.projectId ?? undefined);
          return ok(result, `${result.created ? "Started" : "Using"} Chief thread ${result.threadId}.`);
        }
        if (command === "create") {
          const projectId = args.one("project") ?? context.projectId ?? (await settings.get()).chiefProject;
          if (!projectId) return fail("create requires --project outside a project thread");
          const result = await createChief(projectId);
          return ok(result, `Created Chief thread ${result.threadId}.`);
        }
        if (command === "adopt") {
          const threadId = args.one("thread") ?? args.positional[0];
          if (!threadId) return fail("adopt requires --thread <thread-id>");
          // Adoption rewrites the row in place, so re-adopting a worker would
          // discard the branch and forge links its open PR depends on.
          const registered = store.get(threadId);
          if (registered && registered.role !== "chief") {
            return fail(`Thread ${threadId} is already a managed ${registered.role} (“${registered.title}”). Adopting it would discard its branch, forge links, and report.`);
          }
          const thread = await bb.sdk.threads.get({ threadId });
          const sectionId = await ensureSection();
          const title = `Chief · ${await projectName(thread.projectId)}`;
          await bb.sdk.threads.update({ threadId, sectionId, visibility: "visible", title });
          const previous = chiefForProject(thread.projectId);
          if (previous && previous.thread_id !== threadId) handOver(previous.thread_id, threadId, thread.projectId);
          store.insert({ threadId, role: "chief", projectId: thread.projectId, title, state: thread.status === "active" ? "active" : "idle", status: thread.status });
          await readRules(thread.projectId);
          return ok({ threadId, projectId: thread.projectId, title }, `Adopted ${threadId} as “${title}”.`);
        }
        if (command === "plan") {
          const parsed = planParams.safeParse({
            title: args.one("title"), mission: args.one("mission"), context: args.one("context"),
            revises: args.one("revises"),
          });
          if (!parsed.success) return fail(`Invalid plan brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await startPlan(parsed.data, context.threadId);
          return ok(result, `Started planner “${result.title}” in ${result.threadId}.`);
        }
        if (command === "consult") {
          const parsed = consultParams.safeParse({
            title: args.one("title"), mission: args.one("mission"), context: args.one("context"),
            workerThreadId: args.one("worker"), planThreadId: args.one("plan-thread"),
          });
          if (!parsed.success) return fail(`Invalid consult brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await startConsult(parsed.data, context.threadId);
          return ok(result, `Started advisor “${result.title}” in ${result.threadId}.`);
        }
        if (command === "delegate") {
          const parsed = delegateParams.safeParse({
            title: args.one("title"), mission: args.one("mission"),
            successCriteria: args.all("criteria"), constraints: args.all("constraint"), context: args.one("context"),
            branch: args.one("branch"), issueUrl: args.one("issue-url"), prUrl: args.one("pr-url"),
            replaces: args.one("replaces"),
            planThreadId: args.one("plan-thread"),
            wave: args.one("wave") !== undefined ? Number(args.one("wave")) : undefined,
            unplannedReason: args.one("unplanned-reason"),
            kind: args.one("kind"),
            userApprovedRound: args.bool("user-approved-round") || undefined,
            // undefined, not false: an absent flag must not override replaces: inheritance.
            verifyCommand: args.one("verify"),
          });
          if (!parsed.success) return fail(`Invalid delegate brief: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          const result = await delegate(parsed.data, context.threadId);
          return ok(result, `Started worker “${result.title}” in ${result.threadId}.`);
        }
        if (command === "inspect") {
          const threadId = args.positional[0];
          if (!threadId) return fail("inspect requires <thread-id>");
          const row = store.get(threadId);
          if (!row) return fail(`No managed thread ${threadId}.`);
          if (readScope && (row.project_id !== readProject || !belongsToChief(row, readScope))) {
            return fail(`No managed thread ${threadId} for this Chief.`);
          }
          return ok({ threadId }, await inspect(threadId, row.project_id));
        }
        if (command === "continue") {
          const threadId = args.positional[0];
          const instruction = args.one("instruction");
          if (!threadId || !instruction) return fail("continue requires <thread-id> and --instruction");
          await scoped(threadId);
          const capped = await continueThread(threadId, instruction);
          return ok({ threadId }, `Continued ${threadId}.${capped ? stallCapNote : ""}`);
        }
        if (command === "stop") {
          const parsed = stopParams.safeParse({ threadId: args.positional[0], reason: args.one("reason") });
          if (!parsed.success) return fail(`Invalid stop target: ${parsed.error.issues[0]?.message ?? "check the arguments"}`);
          await scoped(parsed.data.threadId);
          const row = await stopThread(parsed.data.threadId, parsed.data.reason);
          return ok(toManaged(row), `Stopped “${row.title}”. ${row.recommendation}`);
        }
        if (command === "complete") {
          const threadId = args.positional[0];
          if (!threadId) return fail("complete requires <thread-id>");
          await scoped(threadId);
          const override = args.one("override");
          if (override === "true") return fail("--override needs a reason.");
          const reason = overrideSchema.safeParse(override);
          if (!reason.success) return fail("--override must be 1-500 characters.");
          const { row, overridden, cleanup } = await markComplete(threadId, args.one("result"), reason.data);
          const ready = await readyPullRequest(row);
          return ok({ ...toManaged(row), overridden, cleanup, prReady: ready.prReady, ...(ready.error ? { prReadyError: ready.error } : {}) },
            `Marked “${row.title}” complete${overridden ? " without a matching approve (override recorded in its result)" : ""}.${ready.line}${cleanupLine(cleanup)}`);
        }
        return fail(`Unknown command “${command}”.`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pendingReady = true;
  try {
    await reconcile(); // each reconciled row's reload sweeps rows absorbed before this version
  } catch (error) {
    bb.log.warn(`Initial reconciliation deferred: ${String(error)}`);
  }
  store.reload();
  await sweeping;
  await plannerEnabled().catch((error) => bb.log.warn(`Could not read the planner setting: ${String(error)}`));
  await researchSettings().catch((error) => bb.log.warn(`Could not read the researcher settings: ${String(error)}`));
  const initial = await settings.get();
  cleanupActive = initial.cleanupApproved;
  if (initial.autoSpawn && initial.chiefProject) {
    void ensureChief(initial.chiefProject).catch((error) => bb.log.warn(`Could not auto-start Chief: ${String(error)}`));
  }
  bb.log.info("Chief supervisor loaded");
}
