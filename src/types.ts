import { z } from "zod";
import { LESSON_MAX, MAX_FINDINGS, MAX_PLAN_LENGTH, MAX_REPORT_FAILS, MAX_WAVES, REPORT_TEXT_MAX, SUMMARY_MAX } from "./reportLimits";
import { modelRoleSchema, roleSchema, type Role } from "./core/roles";

/** reasoningLevel is a plain string like the SDK's own: providers may define levels beyond `reasoningSchema`, which only guards tool input. */
export const modelSelectionSchema = z.object({
  providerId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningLevel: z.string().trim().min(1),
});
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

export const terminal = (state: string) => ["complete", "archived", "deleted"].includes(state);

/** A reviewer's structured judgement. Chief routes on this field instead of
 * parsing a ship-or-fix opinion out of the report prose. */
export const verdictSchema = z.enum(["approve", "request_changes"]);
export const stateSchema = z.enum([
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

export const modelConfigurationSchema = z.object({
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
      tester: modelSelectionSchema.nullable(),
      "spec-writer": modelSelectionSchema.nullable(),
      reviewer: modelSelectionSchema.nullable(),
      advisor: modelSelectionSchema.nullable(),
    }),
    /** Roles whose stored pick this machine can no longer serve, so spawns use BB's default. */
    unusable: z.array(modelRoleSchema),
  })),
});
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;

export const managedThreadSchema = z.object({
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

export const failEntry = z.object({
  text: z.string().trim().min(1).max(400),
  scope: z.string().trim().min(1).max(120),
  basis: z.string().trim().min(1).max(200).describe("the command, test or input that reproduces it"),
});
export type FailEntry = z.infer<typeof failEntry>;
/** chief_report's fails entry. Published without length limits: checkReport enforces them in one pass, with a fix per field. */
export const reportFailEntry = z.object({
  text: z.string().trim().describe("at most 400 characters"),
  scope: z.string().trim().describe("at most 120 characters"),
  basis: z.string().trim().describe("at most 200 characters: the command, test or input that reproduces it"),
});
// A string is a JSON-encoded array some callers send; the report intake decodes it and checkReport refuses anything else.
export const failsParam = z.union([z.string().trim(), z.array(reportFailEntry)]).optional().describe(
  `Worker or reviewer only: approaches tried and ruled out, so a replacement worker does not retry them. At most ${MAX_REPORT_FAILS} per report.`,
);
/** A reviewer's structured finding, published without limits; checkReport enforces them. */
export const reportFinding = z.object({
  file: z.string().trim().describe("1-300 characters"),
  line: z.number().int().optional().describe("1-based line"),
  severity: z.enum(["blocking", "nit"]),
  message: z.string().trim().describe("1-1000 characters"),
  fix: z.string().trim().optional().describe("at most 1000 characters"),
});
export type ReportFinding = z.infer<typeof reportFinding>;
export const findingsParam = z.union([z.string().trim(), z.array(reportFinding)]).optional().describe(
  `Ready only, reviewer only. Required on a reviewer's ready report ([] allowed for an approve with nothing to note). One entry per finding, at most ${MAX_FINDINGS}. request_changes iff at least one blocking. \`[AMBIGUOUS: …]\` items stay in result, not here.`,
);

/** One wave of a planner's plan array, published without limits; checkReport enforces them. */
export const waveShape = z.object({
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
  spec: z.boolean().optional().describe(
    "true only on an implementation wave that changes documented behaviour: before its worker, a Spec Writer commits docs/ from the wave's `## Spec delta`. Never on a test or design wave.",
  ),
});
// One flat object, published without length limits: the validator's own errors cannot be customised, so checkReport()
// in the report intake enforces every limit and per-state rule and names all failing fields in one error.
export const reportParams = z.object({
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
    "Planner ready report only: true when the plan is high-risk (see your brief). A plan with more than one implementation wave gets one advisor review either way; design and test waves do not count.",
  ),
  plan: z.union([
    z.string().trim(),
    z.array(waveShape),
  ]).optional().describe(
    `Ready only. A planner's ready report requires this: an array of 2 to ${MAX_WAVES} {body, dependsOn, design?, test?, spec?} (1-based) waves, each body at most ${MAX_PLAN_LENGTH.toLocaleString("en-US")} characters. dependsOn has at most one entry: the 1-based earlier wave this one builds on; [] = independent, omitted = depends on the previous wave. design: true marks a design-only wave; test: true marks a test wave, and every chain ends with one; spec: true marks an implementation wave whose ## Spec delta a Spec Writer turns into docs/ before its worker runs. Chief receives each wave as its own file, not inline. No other role sets this.`,
  ),
  blocker: z.string().trim().optional().describe(`Required when state is blocked, at most ${REPORT_TEXT_MAX.toLocaleString("en-US")} characters; leave unset otherwise.`),
  recommendation: z.string().trim().optional().describe(`Required when state is blocked, at most ${REPORT_TEXT_MAX.toLocaleString("en-US")} characters: your recommended decision or next action.`),
  fails: failsParam,
  findings: findingsParam,
});

export type ReportParams = z.infer<typeof reportParams>;

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
   * report intake turn that set it. */
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
  /** Incremented when chief_complete replaces the result; guards the report_path publication in the report intake. */
  result_rev: number;
  /** Worker row only: "designer" for design-tool work, "tester" for test work; null (pre-migration or plain) means worker. */
  kind: "designer" | "tester" | "spec-writer" | null;
  /** legacy: workers delegated on the retired simple tag; read only by bb chief stats */
  simple: number | null;
  /** Worker row only: Chief's reason for completing it with skipReview, without a review; null otherwise. */
  review_skipped: string | null;
  /** Worker row only: Chief's reason for completing unplanned work with no tester (chief_complete testsSkipped); null otherwise. */
  tests_skipped: string | null;
  /** Worker row only: the command the worker's brief makes it run; nothing reruns it. */
  verify_command: string | null;
  /** Chief row only: 1 for a Coordinator. */
  coordinator: number | null;
  /** Chief row only: the Coordinator this child Chief reports to. */
  coordinator_thread_id: string | null;
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
