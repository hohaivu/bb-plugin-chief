// "Researcher as a normal agent" (plan thr_bczk87bbtm, waves 1-3): the ONLY differences allowed between an older tool-config baseline and head that concern research.
// Each literal is copied from plan-1.md (steps 1, 6 and 8), never read from the implementation. The edits are applied FORWARD to the retained baseline inputs (before any instruction cap), so what remains is compared byte for byte.
// 1. The chief_research definition: a new description and a `{question, branch?}` schema. Asserted exactly (apart from the two property descriptions the plan leaves open), then the baseline definition is put back.
// 2. Chief's research instruction line and paragraph (plan step 6 and the `researchLine` text of step 1).
// 3. A planner and a researcher lose chief_research: its tool-list entry, its name in the claude-code preload line, and the planner's research line.

export const RESEARCH_TOOL_DESCRIPTION = "Start a read-only researcher thread for `question`. It works in your checkout (or, with `branch`, a fresh worktree on that branch), decides whether to answer alone or split the question across up to 6 read-only helper threads, and reports through chief_report. The call returns at once; the report arrives as a lifecycle alert, so end your turn instead of polling. Chief only.";
export const RESEARCH_LINE_NEW = "Use chief_research for read-only research by a researcher thread.";
export const researchParagraphNew = (planning: boolean) => `chief_research is optional. A call starts a researcher thread that works alone or with read-only helper threads; end your turn and wait for its report alert. Use it for a broad multi-file scan or independent questions, or to check doubtful worker or reviewer evidence. When a report is partial or failed, do not rerun the same question: send the open question to ${planning ? "chief_plan" : "chief_consult"}, or the doubtful evidence to chief_review.`;

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
  if (Object.keys(properties).join() !== "question,branch") fail("properties");
  if (JSON.stringify(required) !== JSON.stringify(["question"])) fail("question must be the one required field");
  const { description: questionText, ...question } = properties.question;
  const { description: branchText, ...branch } = properties.branch;
  if (JSON.stringify(question) !== JSON.stringify({ type: "string", minLength: 1, maxLength: 4000 }) || !questionText) fail("question");
  if (JSON.stringify(branch) !== JSON.stringify({ type: "string", minLength: 1, maxLength: 300 }) || !branchText) fail("branch");
  tool.description = was.description;
  tool.inputSchema = structuredClone(was.inputSchema);
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
  return lines.join("\n");
}
