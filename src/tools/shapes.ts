import { MAX_WAVES } from "../report/reportIntake";
import { roleSchema, workerKindSchema } from "../core/roles";
import { failEntry } from "../types";
import { clip } from "../core/text";
import { z } from "zod";

/** What a spawn seeds into a thread's pluginMetadata, read back in bb.agents.configure.
 * insertThread runs only after threads.spawn resolves, so the very first configure()
 * call for a brand-new thread can land before that row exists; pluginMetadata is
 * seeded atomically at spawn time and survives that gap. Untrusted input, so parsed
 * defensively like everything else crossing this boundary. */
export const spawnMetadataSchema = z.object({
  role: roleSchema,
  chiefThreadId: z.string().nullable().optional(),
  // Any string: a legacy seeded kind (tester) still parses and reads as worker.
  kind: z.string().optional(),
  planThreadId: z.string().optional(),
});

const delegateShape = z.object({
  title: z.string().trim().min(1).max(160).optional().describe("Exact concise title. Defaults to the first line of mission, clipped to 160 characters."),
  mission: z.string().trim().min(1).max(12_000).describe("What to achieve, in the user's terms. State a cause only from evidence, naming its source (core rules); never your own guess."),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional().describe("Observable outcomes, each checked by a command with its exit status or named for Manual Verification."),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional().describe("Scope, files or behaviour to leave alone, user rules."),
  context: z.string().trim().max(12_000).optional().describe("Evidence with its source per item (user message, issue, report, alert, reviewer verdict); links; prior work."),
  branch: z.string().trim().min(1).max(300).optional().describe(
    "Task branch Chief already created and pushed; the worktree is based on it and the worker commits there. Omit for the project default.",
  ),
  issueUrl: z.string().trim().min(1).max(500).optional().describe("Tracking issue URL Chief opened, when the forge has issues."),
  prUrl: z.string().trim().min(1).max(500).optional().describe("Draft pull request URL Chief opened from the task branch."),
  replaces: z.string().trim().min(1).optional().describe("Finished worker's thread id to hand off from: the new worker starts in its worktree and branch; the old worker is marked complete. A gate fix run gets the gate's verdict file and findings; a chat fix gets none."),
  planThreadId: z.string().trim().min(1).optional().describe("Planner that reported a wave schedule; with wave, its plan file is used."),
  wave: z.number().int().min(1).max(MAX_WAVES).optional().describe("1-based index into planThreadId's wave schedule."),
  unplannedReason: z.string().trim().min(1).max(300).optional().describe("Required when planning is on and this work skips chief_plan: your reason (judgment; core rules). Not needed with planThreadId/wave or replaces."),
  kind: workerKindSchema.optional().describe("designer when the agent decides or implements how the UI looks: drawing or editing in a design tool (Paper, Figma, …), design-to-code, or UI with no approved design or explicit visual spec. worker (default) only when an approved design or an explicit spec (request, issue, report) fixes the look. A replaces: successor keeps the prior kind. A plan's design-only wave (design: true) defaults to designer and only draws; the wave implementing its approved artboards is a worker. spec-writer changes docs/ only: a plan has one, delegated fresh with explicit kind only after every wave is ready, on the last unbypassed spec: true wave the last ready alert names, in its own side worktree; a side Spec Writer's docs fix replaces that writer. On another plan wave (not design-only) a docs change replaces the chain's current implementation row (the call a refusal names). On unplanned work: opt-in, with or without replaces:."),
  verifyCommand: z.string().trim().min(1).max(500).optional().describe("One shell command the worker's brief tells it to run after its last commit, exit 0 before reporting ready, tests included: e.g. `npx tsc --noEmit && bb plugin build`. Inherited through replaces:."),
});

/** Fills an omitted title from the first line of its source field. The title is display-only, so a missing one is not worth a refusal. */
export const titled = <T extends { title?: string }>(source: (value: T) => string) => (value: T) => ({ ...value, title: value.title ?? clip(source(value).split("\n")[0]!.trim(), 160) });

export const delegateParams = delegateShape.superRefine((value, ctx) => {
  if (value.unplannedReason && value.planThreadId) {
    ctx.addIssue({ code: "custom", path: ["unplannedReason"], message: "unplannedReason cannot be combined with planThreadId." });
  }
}).transform(titled((v) => v.mission));

/** A planner is briefed on the same problem as a worker, minus the criteria and
 * constraints it is being asked to propose. */
export const planParams = delegateShape.pick({ title: true, mission: true, context: true }).extend({
  revises: z.string().trim().min(1).optional().describe("Planner whose plan its one advisor review sent back with changes: the new planner revises it with the advice attached; its plan is delegated with no second review."),
  branch: z.string().trim().min(1).max(300).optional().describe("Open branch (e.g. a stacked pull request's head) to read instead of the project default; the thread runs in a fresh worktree based on it. A plan's chain heads stack on it."),
  researchThreadId: z.string().trim().min(1).optional().describe("Design researcher (chief_research design: true) whose design the user approved: its design and fact report become the planner's brief."),
  undesignedReason: z.string().trim().min(1).max(300).optional().describe("Required when research is on and no researchThreadId: why no design discussion is needed (e.g. a small fix). Not with revises."),
}).superRefine((value, ctx) => {
  if (value.researchThreadId && value.undesignedReason) ctx.addIssue({ code: "custom", path: ["undesignedReason"], message: "Pass researchThreadId or undesignedReason, not both." });
  if (value.revises && (value.researchThreadId || value.undesignedReason)) ctx.addIssue({ code: "custom", path: ["revises"], message: "A revision inherits its original plan's design: omit researchThreadId and undesignedReason." });
}).transform(titled((v) => v.mission));

export const consultParams = delegateShape.pick({ title: true, mission: true, context: true }).extend({
  planThreadId: z.string().trim().min(1).describe("Planner whose open plan gets one advisor review before chief_forge_init or chief_delegate."),
  branch: z.string().trim().min(1).max(300).optional().describe("Open branch (e.g. a stacked pull request's head) to read instead of the project default; the thread runs in a fresh worktree based on it."),
}).transform(titled((v) => v.mission));

/** Why a worker is completed without a matching approve; recorded in its result. */
export const overrideSchema = z.string().trim().min(1).max(500).optional();

export const stopParams = z.object({
  threadId: z.string().trim().min(1),
  reason: z.string().trim().max(1_000).optional().describe("Why it is being stopped: what the evidence shows it stuck on."),
});

export const logParams = z.object({
  entries: z.array(failEntry.extend({ kind: z.enum(["FACT", "FAIL"]) })).max(5).optional().describe(
    "Notes for peer waves: FACT for a finding that could change their next step, FAIL for a dead end. Omit to only read.",
  ),
});

export interface TodoRow {
  id: number;
  project_id: string;
  text: string;
  after: string | null;
  state: "open" | "done" | "dropped";
  chief_thread_id: string | null;
  updated_at: number;
}
