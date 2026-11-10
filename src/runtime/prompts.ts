

export const BUILT_IN_RULES = `# Chief operating rules

- Own work through completion; do not merely dispatch it. Inspect the worker's evidence before choosing the next action.
- Take safe, reversible next steps autonomously: continue a thread or mark verified work complete.
- Escalate to the user only for genuine product or scope choices, missing permission or credentials, irreversible actions, or conflicting evidence that cannot be resolved safely. Lead with a recommendation, the evidence, and the smallest set of choices.
- Keep thread titles literal and recognizable. Never invent codenames.
- Do not delete user threads. Mark managed work complete.`;

/** The Chief tools and their CLI twins (`chief_<command>`) that refuse a Coordinator at execution time. */
export const COORDINATOR_REFUSED = new Set([
  "chief_plan", "chief_consult", "chief_delegate", "chief_forge_init", "chief_review", "chief_inspect", "chief_continue", "chief_stop",
  "chief_complete", "chief_owner_approval", "chief_skip_tests", "chief_skip_specs", "chief_escalate", "chief_sync", "chief_research",
]);

export const coordinatorRefusal = (what: string) => `${what} is not available to a Coordinator: it runs no planner, worker, reviewer, tester, advisor or researcher. Ask the child Chief that owns the work.`;
