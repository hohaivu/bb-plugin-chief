import { isDeepStrictEqual } from "node:util";
// "Researcher as a normal agent" (plan thr_bczk87bbtm, waves 1-3): the ONLY differences allowed between an older tool-config baseline and head that concern research.
// Each literal is copied from plan-1.md (steps 1, 6 and 8), never read from the implementation. The edits are applied FORWARD to the retained baseline inputs (before any instruction cap), so what remains is compared byte for byte.
// 1. The chief_research definition: a new description and a `{question, branch?}` schema. Asserted exactly (apart from the two property descriptions the plan leaves open), then the baseline definition is put back.
// 2. Chief's research instruction line and paragraph (plan step 6 and the `researchLine` text of step 1).
// 3. A planner and a researcher lose chief_research: its tool-list entry, its name in the claude-code preload line, and the planner's research line.
// CRISPY stages 1-3 (plan thr_zbmxhv55e9, waves 1-2) amend 1 and 2 and add: the chief_research `design` field, the chief_plan `researchThreadId`/`undesignedReason` fields,
// the chief_report `waitingOnUser` field, and the research-on texts of the planner order line and the core-rules Skips line. Property descriptions come from plan-1 step 3 and step 2, plan-2 step 1.

export const RESEARCH_TOOL_DESCRIPTION = "Start a read-only researcher thread for the ticket in `question`. It works in your checkout (or, with `branch`, a fresh worktree on that branch), turns the ticket into neutral questions and sends them to 1-6 ticket-blind read-only helper threads. `design: false` reports facts only (evidence checks); `design: true` then holds a design discussion with the user in its thread and reports a design.md the user approved (features and multi-file work). It reports through chief_report. The call returns at once; the report arrives as a lifecycle alert, so end your turn instead of polling. Chief only.";
export const RESEARCH_LINE_NEW = "Use chief_research for read-only research by a researcher thread.";
export const researchParagraphNew = (planning: boolean) => `chief_research is optional. A call starts a researcher thread that sends ticket-blind questions to read-only helper threads; end your turn and wait for its report alert. For features and multi-file work, call it with design: true and the ticket as \`question\` before ${planning ? "chief_plan" : "chief_delegate"}. Use design: false to check doubtful worker or reviewer evidence. While a design discussion waits on the user, tell the user once in one line and stay quiet. When a report is partial or failed, do not rerun the same question: send the open question to ${planning ? "chief_plan" : "chief_consult"}, or the doubtful evidence to chief_review.`;

export const QUESTION_DESCRIPTION = "The ticket: the issue text or the user's request in full. With no ticket, your question is the ticket.";
export const DESIGN_DESCRIPTION = "true: research, then a design discussion with the user in the researcher thread, ending in a design.md the user approved (features and multi-file work). false: facts only (evidence checks such as a doubtful worker or reviewer claim).";
export const CHIEF_PLAN_DESCRIPTION_CLAUSE = " With researchThreadId, the user-approved design of a design researcher becomes the brief; while research is on, a plan without one needs undesignedReason.";
export const RESEARCH_THREAD_PROPERTY = { type: "string", minLength: 1, description: "A design researcher (chief_research design: true) whose design the user approved: its design and fact report become the planner's brief." };
export const UNDESIGNED_REASON_PROPERTY = { type: "string", minLength: 1, maxLength: 300, description: "Required when research is on and no researchThreadId: why this work needs no design discussion, e.g. a small fix. Not with revises." };
export const WAITING_ON_USER_PROPERTY = { type: "boolean", description: "Design researcher only, with state active or blocked: true while your design questions wait on the user." };
const PLANNER_ORDER_OLD = "Order: chief_plan (skipped only with unplannedReason: your reason) → chief_forge_init";
const PLANNER_ORDER_NEW = "Order: chief_research (design: true; skipped only with chief_plan undesignedReason: your reason) → the user approves the design in the researcher thread → chief_plan (researchThreadId; no user plan review) (skipped only with unplannedReason: your reason) → chief_forge_init";
const SKIPS_OLD = "the planner (unplannedReason), review (skipReview)";
const SKIPS_NEW = "the planner (unplannedReason), design discussion (undesignedReason), review (skipReview)";

const LINE_START = "Use chief_research (modes: survey, investigate) for parallel read-only research";
const PARAGRAPH_START = "chief_research is optional.";
const PRELOAD_NAME = ",mcp__bb-bridge__chief_research";

/** Asserts the new chief_research definition, then puts the baseline's own definition back so every other byte still compares. A no-op for any other tool. */
export function acceptResearchToolDelta(tool: any, was: any, name: string) {
  if (name !== "chief_research") return;
  const fail = (what: string): never => { throw new Error(`chief_research is not the planned definition: ${what}`); };
  if (tool.description !== RESEARCH_TOOL_DESCRIPTION) fail("description");
  const { properties, required, ...rest } = tool.inputSchema;
  const { properties: _was, required: _wasRequired, ...wasRest } = was.inputSchema;
  if (JSON.stringify(rest) !== JSON.stringify(wasRest)) fail("schema keys");
  if (Object.keys(properties).join() !== "question,design,branch") fail("properties");
  if (JSON.stringify(required) !== JSON.stringify(["question", "design"])) fail("question and design must be the two required fields");
  const { description: questionText, ...question } = properties.question;
  const { description: branchText, ...branch } = properties.branch;
  if (!isDeepStrictEqual(properties.design, { type: "boolean", description: DESIGN_DESCRIPTION })) fail("design");
  if (JSON.stringify(question) !== JSON.stringify({ type: "string", minLength: 1, maxLength: 4000 }) || questionText !== QUESTION_DESCRIPTION) fail("question");
  if (JSON.stringify(branch) !== JSON.stringify({ type: "string", minLength: 1, maxLength: 300 }) || !branchText) fail("branch");
  tool.description = was.description;
  tool.inputSchema = structuredClone(was.inputSchema);
}

/** chief_plan: the two optional design fields and one description clause, asserted exactly and then undone. */
export function acceptPlanDesignDelta(tool: any, was: any, name: string) {
  if (name !== "chief_plan") return;
  const fail = (what: string): never => { throw new Error(`chief_plan is not the planned definition: ${what}`); };
  const { properties, required } = tool.inputSchema;
  if (!isDeepStrictEqual(properties.researchThreadId, RESEARCH_THREAD_PROPERTY)) fail("researchThreadId");
  if (!isDeepStrictEqual(properties.undesignedReason, UNDESIGNED_REASON_PROPERTY)) fail("undesignedReason");
  if ((required ?? []).some((field: string) => field === "researchThreadId" || field === "undesignedReason")) fail("both design fields must stay optional");
  if (tool.description !== `${was.description}${CHIEF_PLAN_DESCRIPTION_CLAUSE}`) fail("description");
  delete properties.researchThreadId;
  delete properties.undesignedReason;
  tool.description = was.description;
}

/** chief_report: the one optional `waitingOnUser` boolean, asserted exactly and then undone. */
export function acceptWaitingOnUserDelta(tool: any, name: string) {
  if (name !== "chief_report") return;
  const { properties, required } = tool.inputSchema;
  if (!isDeepStrictEqual(properties.waitingOnUser, WAITING_ON_USER_PROPERTY) || (required ?? []).includes("waitingOnUser")) throw new Error("chief_report.waitingOnUser: must be the one optional boolean");
  delete properties.waitingOnUser;
}

type Entry = { key: string; tools: string[]; instructions?: string | null };
const once = (lines: string[], start: string, key: string) => {
  const at = lines.findIndex((line) => line.startsWith(start));
  if (at < 0 || lines.some((line, index) => index > at && line.startsWith(start))) throw new Error(`${key}: baseline has not exactly one "${start}" line`);
  return at;
};

/** The baseline tool list of `key`'s role with the authorized research edit applied: a planner or researcher loses chief_research. */
export function researchTools(base: Entry) {
  const stripped = /\| (planner|researcher) \|/.test(base.key);
  return stripped ? base.tools.filter((tool) => tool !== "chief_research") : base.tools;
}

/** The baseline instructions of `base` with the authorized research edits applied (uncapped input: cap AFTER this). Entries the delta does not touch come back unchanged. */
export function researchInstructions(base: Entry) {
  const text = base.instructions;
  if (!text) return text;
  const { key } = base;
  const researchOn = key.includes("| research true");
  const lines = text.split("\n");
  if (/\| (planner|researcher) \|/.test(key)) {
    if (!base.tools.includes("chief_research")) return text;
    if (/\| planner \|/.test(key)) lines.splice(once(lines, LINE_START, key), 1);
    else if (lines.some((line) => line.startsWith(LINE_START))) throw new Error(`${key}: a researcher has no research line in the baseline`);
    return lines.map((line) => (line.includes("ToolSearch") ? line.replace(PRELOAD_NAME, "") : line)).join("\n");
  }
  if (!key.includes("| chief |")) return text;
  if (!researchOn) {
    if (lines.some((line) => line.startsWith(LINE_START) || line.startsWith(PARAGRAPH_START))) throw new Error(`${key}: research off but the baseline has a research line`);
    return text;
  }
  return chiefResearchEdit(text, key);
}

/** A plain Chief's baseline text with its research line and paragraph rewritten (research on). Whether the paragraph names chief_plan or chief_consult is read from the baseline's own paragraph. */
export function chiefResearchEdit(text: string, label = "a plain Chief") {
  const lines = text.split("\n");
  const paragraph = lines[once(lines, PARAGRAPH_START, label)]!;
  const planning = paragraph.includes("send the open question to chief_plan,");
  if (!planning && !paragraph.includes("send the open question to chief_consult,")) throw new Error(`${label}: baseline research paragraph names neither chief_plan nor chief_consult`);
  lines[once(lines, LINE_START, label)] = RESEARCH_LINE_NEW;
  lines[once(lines, PARAGRAPH_START, label)] = researchParagraphNew(planning);
  // Research on: the planner order starts with the design discussion (only when planning is on), and the Skips line names undesignedReason.
  const skips = once(lines, "- Skips:");
  if (!lines[skips]!.includes(SKIPS_OLD)) throw new Error(`${label}: baseline Skips line lacks the planner clause`);
  lines[skips] = lines[skips]!.replace(SKIPS_OLD, SKIPS_NEW);
  const planner = lines.findIndex((line) => line.startsWith("Planning is on."));
  if (planning !== (planner >= 0)) throw new Error(`${label}: baseline planner line and research paragraph disagree about planning`);
  if (planner >= 0) {
    if (lines[planner]!.split(PLANNER_ORDER_OLD).length !== 2) throw new Error(`${label}: baseline planner line lacks the order clause`);
    lines[planner] = lines[planner]!.replace(PLANNER_ORDER_OLD, PLANNER_ORDER_NEW);
  }
  return lines.join("\n");
}
