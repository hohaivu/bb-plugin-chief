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
/** Said on every planner continuation; the planner brief states the same rules in its Working contract. */
export const PLAN_ONLY = `Remain read-only: ${READ_ONLY}. Submit the plan itself through chief_report's plan field, not as a file write. A worker implements the plan in its own worktree.`;
/** Same for an advisor: said when the consult starts and again on every continuation. */
export const ADVISE_ONLY = `Remain advisory: ${READ_ONLY}. You may read code and run commands to reproduce the problem (a filtered test or build whose only side effects are untracked build or cache output). Report your advice to Chief; a worker makes the change.`;
/** Same for a researcher: said when it starts and again on every continuation. It shares Chief's checkout. */
export const RESEARCH_ONLY = `Remain read-only: ${READ_ONLY}, and run no command that changes tracked files or git state; you share Chief's checkout. Report the findings through chief_report; a worker makes any change.`;
/** What chief_continue appends to a nudge so a read-only role stays read-only; a worker and Chief get none. */
export const CONTINUE_REMINDERS: Partial<Record<Role, string>> = {
  reviewer: REVIEW_ONLY,
  planner: PLAN_ONLY,
  advisor: ADVISE_ONLY,
  researcher: RESEARCH_ONLY,
};

// A new role needs a NEW appended migration (never an edit to an existing one) that rebuilds both tables whose
// role list is a CHECK constraint in MIGRATIONS (server.ts):
//   - managed_threads: the latest rebuild is managed_threads_v4 (role IN chief, planner, worker, reviewer, advisor, researcher).
//   - chief_models: the latest rebuild is chief_models_v9 (role IN chief, planner, worker, reviewer, advisor, designer, tester, spec-writer, researcher); its tester rows are legacy, never read.

/** Planners whose plan is being published or whose consult is being admitted: each refuses the other before anything changes. */
export const planAdmissions = new Set<string>();
