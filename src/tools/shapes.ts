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
  title: z.string().trim().min(1).max(160).optional().describe("Exact concise title for the worker thread. Optional: defaults to the first line of mission, clipped to 160 characters."),
  mission: z.string().trim().min(1).max(12_000).describe("What to achieve, in the user's terms. State a cause only when evidence already states it (see the core rules), naming its source; never your own guess."),
  successCriteria: z.array(z.string().trim().min(1).max(1_000)).max(30).optional().describe("Observable outcomes: each one checked by a command with its exit status, or named for Manual Verification."),
  constraints: z.array(z.string().trim().min(1).max(1_000)).max(30).optional().describe("Limits the work must respect: scope, files or behaviour to leave alone, user rules."),
  context: z.string().trim().max(12_000).optional().describe("Supporting evidence, each item with its source (user message, issue, report, alert, reviewer verdict), plus links and prior work."),
  branch: z.string().trim().min(1).max(300).optional().describe(
    "The task branch Chief already created and pushed. The worktree is based on it and the worker commits there. Omit to base the worktree on the project default.",
  ),
  issueUrl: z.string().trim().min(1).max(500).optional().describe("URL of the tracking issue Chief opened for this task, when the forge has issues."),
  prUrl: z.string().trim().min(1).max(500).optional().describe("URL of the draft pull request Chief opened from the task branch."),
  replaces: z.string().trim().min(1).optional().describe("A finished worker's thread id to hand off from: the new worker starts in that worker's worktree and branch, and the old worker is marked complete. A gate fix run gets the gate's verdict file and findings; a chat fix gets none."),
  planThreadId: z.string().trim().min(1).optional().describe("A planner thread that reported a wave schedule. Combined with wave, the plugin takes the plan file from that schedule."),
  wave: z.number().int().min(1).max(MAX_WAVES).optional().describe("1-based index into planThreadId's wave schedule."),
  unplannedReason: z.string().trim().min(1).max(300).optional().describe("Required when planning is on and this work skips chief_plan: your reason for skipping the plan (your judgment; see the core rules). Not needed with planThreadId/wave or replaces."),
  kind: workerKindSchema.optional().describe("designer when the agent decides or implements how the UI looks: drawing or editing in a design tool (Paper, Figma, …), implementing a design-tool artboard in code (design-to-code), or building UI with no approved design or explicit visual spec. worker (the default) only when an approved design or an explicit spec in the request, an issue, or a report already fixes the look. A replaces: successor keeps the prior worker's kind. Exception: a plan's design-only wave (design: true) defaults to designer and only draws; the wave that implements its approved artboards is a worker. spec-writer changes docs/ only: on a plan's spec: true implementation wave a plan has one Spec Writer: delegate it with an explicit kind only after every wave is ready, on the last unbypassed spec wave the last ready alert names, in its own side worktree; a side Spec Writer's docs fix replaces that writer; on any other plan wave except a design-only one it replaces the chain's current implementation row (the call a refusal names) for a docs change; on unplanned work it is opt-in, with or without replaces:."),
  verifyCommand: z.string().trim().min(1).max(500).optional().describe("One shell command the worker's brief tells it to run after its last commit and get exit 0 from before reporting ready: a build/lint check for a worker, e.g. `npx tsc --noEmit && bb plugin build`. Inherited through replaces:."),
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
  revises: z.string().trim().min(1).optional().describe("A planner whose plan its one advisor review sent back with changes: the new planner revises that plan with the advice attached, and its plan is delegated with no second review."),
  branch: z.string().trim().min(1).max(300).optional().describe("An open branch (for example a stacked pull request's head) to read instead of the project default: the thread runs in a fresh worktree based on it. For a plan, its chain heads stack on this branch."),
  researchThreadId: z.string().trim().min(1).optional().describe("A design researcher (chief_research design: true) whose design the user approved: its design and fact report become the planner's brief."),
  undesignedReason: z.string().trim().min(1).max(300).optional().describe("Required when research is on and no researchThreadId: why this work needs no design discussion, e.g. a small fix. Not with revises."),
}).superRefine((value, ctx) => {
  if (value.researchThreadId && value.undesignedReason) ctx.addIssue({ code: "custom", path: ["undesignedReason"], message: "Pass researchThreadId or undesignedReason, not both." });
  if (value.revises && (value.researchThreadId || value.undesignedReason)) ctx.addIssue({ code: "custom", path: ["revises"], message: "A revision inherits its original plan's design: omit researchThreadId and undesignedReason." });
}).transform(titled((v) => v.mission));

export const consultParams = delegateShape.pick({ title: true, mission: true, context: true }).extend({
  planThreadId: z.string().trim().min(1).describe("A planner whose open plan you want one read-only advisor review of before chief_forge_init or chief_delegate."),
  branch: z.string().trim().min(1).max(300).optional().describe("An open branch (for example a stacked pull request's head) to read instead of the project default: the thread runs in a fresh worktree based on it."),
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
