import { z } from "zod";

/** `researcher` is a support role like the advisor: the thread a Chief's chief_research starts. */
export const roleSchema = z.enum(["chief", "planner", "worker", "reviewer", "advisor", "researcher"]);
export type Role = z.infer<typeof roleSchema>;

/** A worker's kind: `designer` (design-tool work) and `spec-writer` (changes docs/ only)
 * are worker rows, not thread roles. */
export const workerKindSchema = z.enum(["worker", "designer", "spec-writer"]);
export type WorkerKind = z.infer<typeof workerKindSchema>;

/** The role key chief_models stores a per-machine model pick under: the thread roles plus the worker kinds
 * `designer` and `spec-writer`. Explicit, not derived from roleSchema: a worker kind is not a thread role. */
export const modelRoleSchema = z.enum(["chief", "planner", "worker", "reviewer", "advisor", "designer", "spec-writer", "researcher"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

/** A model role with no pick of its own reads another role's pick: no Designer or Spec Writer row inherits the Worker pick. */
export const MODEL_FALLBACK: Partial<Record<ModelRole, ModelRole>> = { designer: "worker", "spec-writer": "worker" };

/** The one read-only rule every non-implementing role shares. Untracked build/test output is not a change. */
export const READ_ONLY = "do not create, modify, or delete any file the repository tracks, and do not commit or push";
/** One wording for the reviewer's read-only rule, said when the review starts and
 * again on every continuation — the two places an edit instruction could arrive. */
export const REVIEW_ONLY = `Remain review-only: ${READ_ONLY}. A repair goes back to the worker, which then earns its own review.`;
const TASK_REPORT = "Submit the plan itself through chief_report's plan field, not as a file write. A worker implements the plan in its own worktree.";
const EPIC_REPORT = "Submit no plan field: report ready with the epic URL (or the named target's path) in result. The epic's issues are the deliverable; no worker implements them.";
/** The one planner report contract. Said on every planner continuation with the row's mode (epic true or false), and in the planner rules
 * with no mode (the brief's Mode line decides): a continuation never carries the other mode's instruction. */
export const planOnly = (epic?: boolean) => `Remain read-only: ${READ_ONLY}. ${epic === undefined ? `Task mode: ${TASK_REPORT} Epic mode: ${EPIC_REPORT}` : epic ? EPIC_REPORT : TASK_REPORT}`;
/** Same for an advisor: said when the consult starts and again on every continuation. */
export const ADVISE_ONLY = `Remain advisory: ${READ_ONLY}. You may read code and run commands to reproduce the problem (a filtered test or build whose only side effects are untracked build or cache output). Report your advice to Chief; a worker makes the change.`;
/** Same for a researcher: said when it starts and again on every continuation. It shares Chief's checkout. */
export const RESEARCH_ONLY = `Remain read-only: ${READ_ONLY}, and run no command that changes tracked files or git state; you share Chief's checkout. Report the findings through chief_report; a worker makes any change.`;
/** What chief_continue appends to a nudge so a read-only role stays read-only; a worker and Chief get none, a planner gets planOnly(its mode). */
export const CONTINUE_REMINDERS: Partial<Record<Role, string>> = {
  reviewer: REVIEW_ONLY,
  advisor: ADVISE_ONLY,
  researcher: RESEARCH_ONLY,
};

// A new role needs a NEW appended migration (never an edit to an existing one) that rebuilds both tables whose
// role list is a CHECK constraint in MIGRATIONS (server.ts):
//   - managed_threads: the latest rebuild is managed_threads_v4 (role IN chief, planner, worker, reviewer, advisor, researcher).
//   - chief_models: the latest rebuild is chief_models_v9 (role IN chief, planner, worker, reviewer, advisor, designer, tester, spec-writer, researcher); its tester rows are legacy, never read.

/** Planners whose plan is being published or whose consult is being admitted: each refuses the other before anything changes. */
export const planAdmissions = new Set<string>();
