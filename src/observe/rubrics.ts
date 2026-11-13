// Rubric format, the aggregation and the filing bar are adapted from warpdotdev/common-skills (MIT),
// .agents/skills/skill-doctor/ at 8792394ff1b655e0af451b8fabb68ef0cfcbd208:
// scorers/{efficiency,procedure-compliance,verbosity}.md, SKILL.md (Step 3 math, fail filter), references/skill-improvements.md.
// The wording is rewritten for Chief (brief, AGENTS.md, skills, Working contract).

/** Bump on any change to a rubric, its labels or its weights: scores are stored and trended per version, never mixed. */
export const RUBRIC_VERSION = "2026-11-13.1";

export const INSUFFICIENT = "insufficient_evidence";
export const NOT_APPLICABLE = "not_applicable";

export interface RubricLabel { value: string; description: string; score: number | null }
export interface Rubric {
  name: string;
  /** all: every judged thread. tester: Tester workers only. handoff: one score per Chief↔child handoff, stored on the child. */
  applies: "all" | "tester" | "handoff";
  weight: number;
  labels: RubricLabel[];
  assess: string[];
  reason: string;
}

const REASON = "Reason: 1–3 sentences citing specifics, each as threadId#seq from the bundle. A claim with no cited moment is not evidence.";
const extra = (what: string): RubricLabel[] => [
  { value: NOT_APPLICABLE, description: `${what} does not apply to this thread`, score: null },
  { value: INSUFFICIENT, description: "the bundle does not hold enough evidence to judge; use this instead of guessing", score: null },
];

export const RUBRICS: Rubric[] = [
  {
    name: "efficiency", applies: "all", weight: 0.25,
    labels: [
      { value: "highly_efficient", description: "direct path to the goal; no wasted calls", score: 1 },
      { value: "mostly_efficient", description: "a few detours or repeated reads, none costly", score: 0.8 },
      { value: "mostly_inefficient", description: "many wasted, failed or repeated calls, or long detours", score: 0.4 },
      { value: "highly_inefficient", description: "most of the effort was wasted, looped or off the goal", score: 0.2 },
      ...extra("efficiency"),
    ],
    assess: [
      "Failed tool calls and calls whose result was never used count as waste.",
      "The same file, command or search repeated without a change in between is waste.",
      "A legitimate retry after a real fix is not waste.",
      "Compare the effort to the size of the brief's task, not to an ideal agent.",
    ],
    reason: REASON,
  },
  {
    name: "procedure-compliance", applies: "all", weight: 0.2,
    labels: [
      { value: "fully_compliant", description: "followed the brief, AGENTS.md, the loaded skills and the Working contract", score: 1 },
      { value: "mostly_compliant", description: "minor slips that did not change the outcome", score: 0.8 },
      { value: "noncompliant", description: "skipped or broke a stated rule, constraint or report requirement", score: 0.2 },
      ...extra("procedure compliance"),
    ],
    assess: [
      "Check the brief's Constraints, Contracts, Verify command, Git workflow and the Working contract line by line.",
      "A required chief_report field, a forbidden action (editing docs/, writing tests, merging) or a skipped verify run is a violation.",
      "Judge the thread against the instructions it actually had in the bundle, not against instructions it never saw.",
    ],
    reason: REASON,
  },
  {
    name: "verbosity", applies: "all", weight: 0.15,
    labels: [
      { value: "proportionate", description: "messages and reports as long as the content needs", score: 1 },
      { value: "verbose", description: "padding, repetition, restating the brief or narrating every step", score: 0.2 },
      { value: "terse", description: "too short to follow: missing the evidence or the reason a reader needs", score: 0.1 },
      ...extra("verbosity"),
    ],
    assess: [
      "Look at agent messages and the final chief_report: length against information.",
      "A report that lists evidence a reviewer needs is not verbose.",
      "A report with a bare 'done' and no evidence is terse.",
    ],
    reason: REASON,
  },
  {
    name: "test-redundancy", applies: "tester", weight: 0.15,
    labels: [
      { value: "lean", description: "each test proves one contract; no duplicate coverage", score: 1 },
      { value: "some_redundancy", description: "a few tests overlap or a heavier test was used where a lighter one proves the same thing", score: 0.6 },
      { value: "redundant", description: "much duplicate coverage, or tests that only work around a problem", score: 0.2 },
      ...extra("test redundancy"),
    ],
    assess: [
      "Duplicate coverage: two tests that fail for the same reason.",
      "An end-to-end test where a unit test proves the contract.",
      "Several tests for one property.",
      "A full-suite rerun where a filtered run would do.",
      "Workaround-only tests: they pass by avoiding the behaviour instead of exercising it.",
    ],
    reason: REASON,
  },
  {
    name: "communication", applies: "handoff", weight: 0.25,
    labels: [
      { value: "clear", description: "the brief and alerts carried what the child needed; no avoidable block, question or round", score: 1 },
      { value: "minor_gaps", description: "small gaps that cost a message or two", score: 0.7 },
      { value: "costly_gaps", description: "gaps that caused a block, a repeated question or a wasted review round", score: 0.4 },
      { value: "broken", description: "the handoff failed: the child worked on the wrong thing or lost the user's intent", score: 0.1 },
      ...extra("communication"),
    ],
    assess: [
      "(a) A brief gap that caused a block or a question.",
      "(b) Information asked twice, on either side.",
      "(c) Nudges: the count is observed; attribute a cause only with evidence; a legitimate nudge is not waste.",
      "(d) Review rounds caused by an unclear brief, not by worker error.",
      "(e) Handoff size: brief and alert characters; tokens are an estimate (characters / 4) and must be labelled \"estimate\".",
      "(f) Loss or distortion of the user's words between Chief's user messages and the delegated brief or mission.",
      "Cover briefs, plan missions, alerts, nudges and bb thread tell. Cite threadId#seq on both sides.",
      "If either side of the handoff is missing from the bundle, answer insufficient_evidence.",
    ],
    reason: REASON,
  },
];

export const rubricByName = (name: string) => RUBRICS.find((rubric) => rubric.name === name);

/** The rubrics that score one judged thread (not the handoff one). A tester worker adds test-redundancy. */
export const applicableRubrics = (kind: string | null | undefined) =>
  RUBRICS.filter((rubric) => rubric.applies === "all" || (rubric.applies === "tester" && kind === "tester")).map((rubric) => rubric.name);

/** The rubric in skill-doctor's format: a YAML labels block, the Assess bullets and the Reason rule. */
export function renderRubric(rubric: Rubric): string {
  return [
    `## ${rubric.name}`,
    "```yaml",
    "labels:",
    ...rubric.labels.flatMap((label) => [`  - value: ${label.value}`, `    description: ${label.description}`, `    score: ${label.score === null ? "null" : label.score}`]),
    "```",
    "Assess:",
    ...rubric.assess.map((line) => `- ${line}`),
    rubric.reason,
  ].join("\n");
}

/** skill-doctor's 0.5 + 0.5·s: a raw score of 0 still reads as half credit. */
export const curve = (score: number) => 0.5 + 0.5 * score;

export interface ScoreInput { scorer: string; score: number | null; label?: string }
export type ThreadStatus = "pass" | "fail" | "insufficient";
export interface Aggregate {
  status: ThreadStatus;
  /** Σ w·curve(raw) / Σ w over the applicable dimensions that have a score; null when none has. NOT skill-doctor's overall: code_quality and skill_coverage are omitted (the reviewer owns code), so the weights renormalize. */
  overall: number | null;
  failed: boolean;
  raw: Record<string, number>;
  curved: Record<string, number>;
}

/** One thread. `applicable` names the rubrics that must be present (default: those given). A dimension labelled not_applicable leaves the set;
 * insufficient_evidence or a missing dimension keeps it, so the thread cannot pass. A raw score below 0.5 fails; exactly 0.5 does not. */
export function aggregate(scores: readonly ScoreInput[], applicable?: readonly string[]): Aggregate {
  const byScorer = new Map(scores.map((entry) => [entry.scorer, entry]));
  const required = (applicable ?? scores.map((entry) => entry.scorer)).filter((name) => byScorer.get(name)?.label !== NOT_APPLICABLE);
  const raw: Record<string, number> = {};
  const curved: Record<string, number> = {};
  let weighted = 0, weights = 0, missing = false;
  for (const name of required) {
    const entry = byScorer.get(name);
    if (!entry || entry.label === INSUFFICIENT || typeof entry.score !== "number" || Number.isNaN(entry.score)) { missing = true; continue; }
    raw[name] = entry.score;
    curved[name] = curve(entry.score);
    const weight = rubricByName(name)?.weight ?? 0;
    weighted += weight * curved[name]!;
    weights += weight;
  }
  const failed = Object.values(raw).some((score) => score < 0.5);
  const overall = weights > 0 ? weighted / weights : null;
  const status: ThreadStatus = failed ? "fail" : missing || !Object.keys(raw).length ? "insufficient" : "pass";
  return { status, overall, failed, raw, curved };
}

/** Every surface a lesson may name: the skill directories under skills/, the prompt and brief surfaces, plugin code and other.
 * shortcut: a static copy of `ls skills/`, update it when a skill directory is added. */
export const SURFACES = [
  "chief", "chief-role-designer", "chief-role-read-only", "chief-role-reviewer", "chief-role-spec-writer", "chief-role-tester", "chief-role-worker", "chief-worker", "coordinator",
  "planner-prompt", "worker-brief", "reviewer-brief", "tester-brief", "chief-delegate-brief", "chief-plan-mission", "chief-alert-text", "chief-nudge", "chief-tell",
  "report-contract", "plugin-code", "other",
] as const;

const CHIEF_SURFACES = new Set(["chief", "chief-delegate-brief", "chief-plan-mission", "chief-alert-text", "chief-nudge", "chief-tell"]);
/** Which prompts a lesson reaches: reviewer-brief → reviewers, Chief's own surfaces → Chief, everything else → every managed role (NULL).
 * Explicit set, not a `chief-*` prefix: chief-worker and chief-role-* are managed-role skills. */
export const lessonRole = (surface: string): "reviewer" | "chief" | null => surface === "reviewer-brief" ? "reviewer" : CHIEF_SURFACES.has(surface) ? "chief" : null;
