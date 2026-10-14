import { z } from "zod";

/** `researcher` is a support role like the advisor: the child a Chief's chief_research runs in. */
export const roleSchema = z.enum(["chief", "planner", "worker", "reviewer", "advisor", "researcher"]);
export type Role = z.infer<typeof roleSchema>;

/** A worker's kind: `designer` is a worker row for design-tool work, not a thread role. */
export const workerKindSchema = z.enum(["worker", "designer"]);
export type WorkerKind = z.infer<typeof workerKindSchema>;

/** The role key chief_models stores a per-machine model pick under: the lifecycle roles plus
 * `designer` (a worker kind, not a thread role). Explicit, not derived from roleSchema: the researcher's
 * model is the mode's research pick, and chief_models' CHECK would refuse it. */
export const modelRoleSchema = z.enum(["chief", "planner", "worker", "reviewer", "advisor", "designer"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

export const researchRoleSchema = z.enum(["chief", "planner", "researcher"]);
export type ResearchRole = z.infer<typeof researchRoleSchema>;

/** A model role with no pick of its own reads another role's pick: no Designer row inherits the Worker pick. */
export const MODEL_FALLBACK: Partial<Record<ModelRole, ModelRole>> = { designer: "worker" };

/** The role skill each managed role loads next to the shared chief-worker core. */
export const ROLE_SKILLS: Record<Exclude<Role, "chief">, string[]> = {
  planner: ["chief-role-read-only"],
  advisor: ["chief-role-read-only"],
  worker: ["chief-role-worker"],
  reviewer: ["chief-role-reviewer"],
  researcher: [],
};

/** Every skill a managed thread loads: the shared core, its role's skills, and the designer skill for a designer worker. */
export function managedSkills(role: Exclude<Role, "chief">, kind: WorkerKind | null | undefined): string[] {
  return ["chief-worker", ...ROLE_SKILLS[role], ...(role === "worker" && kind === "designer" ? ["chief-role-designer"] : [])];
}

/** The one read-only rule every non-implementing role shares. Untracked build/test output is not a change. */
export const READ_ONLY = "do not create, modify, or delete any file the repository tracks, and do not commit or push";
/** One wording for the reviewer's read-only rule, said when the review starts and
 * again on every continuation — the two places an edit instruction could arrive. */
export const REVIEW_ONLY = `Remain review-only: ${READ_ONLY}. A repair goes back to the worker, which then earns its own review.`;
/** Same for a planner: said when the plan starts and again on every continuation. */
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
//   - chief_models: the latest rebuild is chief_models_v6 (role IN chief, planner, worker, reviewer, advisor, designer).
