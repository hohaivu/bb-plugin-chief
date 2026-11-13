// Shrink-prompts wave 1: the base-recorded oracles (fixtures written on older bases) are compared with head after these named edits,
// applied to the BASE text (base -> head), never by normalizing head back:
//   (a) an alert's action line was clipped at 400 characters on base and now stays whole up to 1,200. The whole text is not typed here:
//       the exposed bytes come from a base-recorded fixture that holds the same action unclipped (the `chief_roster` Pending line,
//       forAlert = false): in the same text, else, with the thread ids renamed, in another base fixture. The clipped prefix must match exactly.
//   (b) an alert clipped only for that action no longer writes a report file, so its `Full report: <path>` line goes (exactly one per such block).
const CLIPPED = 400;

export function expandClippedActions(text: string, ...otherBaseTexts: string[]): string {
  const lines = [text, ...otherBaseTexts].flatMap((source) => source.split("\n"));
  // The same action with other thread ids: its prefix must match once the ids are renamed by first appearance, and its tail names no thread.
  const shape = (value: string) => { const seen: string[] = []; return value.replace(/thr_\d+/g, (id) => `#${seen.includes(id) ? seen.indexOf(id) : seen.push(id) - 1}`); };
  const wholeOf = (clipped: string) => {
    const prefix = clipped.slice(0, CLIPPED - 1);
    const exact = new Set<string>();
    const renamed = new Set<string>();
    for (const line of lines) {
      if (line === clipped) continue;
      const at = line.indexOf(prefix);
      if (at !== -1 && line.length - at > CLIPPED) exact.add(line.slice(at));
      const start = line.indexOf(prefix.slice(0, 12));
      if (start !== -1 && line.length - start > CLIPPED && shape(line.slice(start, start + CLIPPED - 1)) === shape(prefix) && !/thr_\d/.test(line.slice(start + CLIPPED - 1))) {
        renamed.add(prefix + line.slice(start + CLIPPED - 1));
      }
    }
    const wholes = exact.size ? exact : renamed;
    if (wholes.size !== 1) throw new Error(`expected exactly one whole action for a clipped line, found ${wholes.size}: ${clipped.slice(0, 80)}`);
    return [...wholes][0]!;
  };
  return text.split("\n").map((line) => (line.length === CLIPPED && line.endsWith("…") ? wholeOf(line) : line)).join("\n");
}

/** Base alert blocks (text from `[Chief lifecycle alert]` to the next blank line or `---`) whose action was clipped lose their report-file pointer. */
export function dropPointerOfClippedActions(base: string, expanded: string): string {
  const baseBlocks = base.split(/(?=\[Chief lifecycle alert\])/);
  const expandedBlocks = expanded.split(/(?=\[Chief lifecycle alert\])/);
  if (baseBlocks.length !== expandedBlocks.length) throw new Error("block count changed by the expansion");
  return expandedBlocks.map((block, index) => {
    if (block === baseBlocks[index]) return block;
    if (/\(clipped[;)]|…and \d+ more/.test(block)) throw new Error("an alert clipped for another reason keeps its report file");
    const pointer = block.split("\n").filter((line) => /^Full report: \S+\.md$/.test(line));
    if (pointer.length !== 1) throw new Error(`expected exactly one Full report pointer, found ${pointer.length}`);
    return block.replace(`${pointer[0]}\n`, "").replace("\nResult (clipped, full text in the report file): ", "\nResult: ");
  }).join("");
}

/** `otherBaseTexts`: further base-recorded fixtures that hold the same action unclipped (matched by the exact clipped prefix, thread ids included). */
export const shrinkAlerts = (base: string, ...otherBaseTexts: string[]) => dropPointerOfClippedActions(base, expandClippedActions(base, ...otherBaseTexts));

// (c) A worker report's stored file now exists only when something still overflows. Base wrote it also for an action over 400 characters, which a worker
// ready alert reaching this review prompt always had; head writes it when a recorded command ran without a failure (the alert lists failed commands only,
// so the file keeps the rest). On a review prompt whose recorded block is the base's own bytes this is, per review context: with `Recorded: none recorded`
// the `Full report: <path>` pointer line goes (and an earlier-worker entry loses its `Full report: <path>; ` prefix); with a zero-exit command in the block,
// the pointer line appears above `Full report and last output:`. Counts are exact, so any other pointer line fails the test.
export function shrinkReportPointers(base: string, expected: { dropped: number; earlier: number; added: number }): string {
  const lines = base.split("\n");
  const count = { dropped: 0, earlier: 0, added: 0 };
  let recorded: "none" | "ran" | "other" = "other";
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("## Recorded commands")) {
      const block = lines.slice(index + 1, index + 1 + lines.slice(index + 1).findIndex((entry) => entry === ""));
      recorded = block[0] === "Recorded: none recorded" ? "none" : block.some((entry) => / → exit 0$/.test(entry)) ? "ran" : "other";
    }
    if (/^Full report: <storage>\/chief\/\S+\/report-\d+\.md$/.test(line) && recorded === "none") { count.dropped++; return; }
    const earlier = /^(- worker \S+: )Full report: <storage>\/chief\/\S+\/report-\d+\.md; (bb chief inspect \S+)$/.exec(line);
    if (earlier && lines[index + 1] === "  Recorded: none recorded") { count.earlier++; out.push(`${earlier[1]}${earlier[2]}`); return; }
    const inspect = /^Full report and last output: bb chief inspect (\S+)$/.exec(line);
    if (inspect && recorded === "ran" && !/^Full report: /.test(lines[index - 1]!)) { count.added++; out.push(`Full report: <storage>/chief/proj_1/${inspect[1]}/report-1.md`); }
    out.push(line);
  });
  if (JSON.stringify(count) !== JSON.stringify(expected)) throw new Error(`report pointer edits ${JSON.stringify(count)} differ from the expected ${JSON.stringify(expected)}`);
  return out.join("\n");
}

// (d) A planner alert that shows the plan with inline-vis lines no longer lists the same wave paths as `Wave n of N: <path>` lines; the intro line gains
// its "Plan files, wave 1 first. " lead. Applied to a base alert string: the lines between `Plan: N wave(s)` and the intro go (one per wave), the lead is added.
export const INLINE_INTRO_BASE = "To show the plan to the user, put each line below alone on its own line in your reply (not in a code block):";
export const INLINE_INTRO_HEAD = `Plan files, wave 1 first. ${INLINE_INTRO_BASE}`;
export function shrinkPlannerAlert(alert: string): string {
  const lines = alert.split("\n");
  const intro = lines.indexOf(INLINE_INTRO_BASE);
  if (intro === -1) return alert;
  const plan = lines.findIndex((line) => /^Plan: \d+ wave\(s\)$/.test(line));
  const waves = lines.slice(plan + 1, intro);
  if (plan === -1 || !waves.length || !waves.every((line, index) => new RegExp(`^Wave ${index + 1} of ${waves.length}: \\S+/plan-${index + 1}\\.md$`).test(line))) {
    throw new Error("a planner alert with the inline intro lists its waves differently from the base shape");
  }
  return [...lines.slice(0, plan + 1), INLINE_INTRO_HEAD, ...lines.slice(intro + 1)].join("\n");
}
/** Applies `edit` to every string inside a JSON value. */
export const mapStrings = <T>(value: T, edit: (text: string) => string): T => JSON.parse(JSON.stringify(value), (_key, entry) => (typeof entry === "string" ? edit(entry) : entry));

/** (b') The roster's `  report: <path>` lines of workers whose report file is no longer written. */
export const dropRosterReportLines = (text: string) => text.split("\n").filter((line) => !/^  report: <storage>\/chief\/\S+\/report-\d+\.md$/.test(line)).join("\n");

/** A base oracle kept as JSON text (every string may hold alerts or a roster): edits (a), (b) and (b') on each string; the whole action comes from any string of the same file. */
export function shrinkJsonOracle(raw: string): string {
  const value = JSON.parse(raw);
  const strings: string[] = [];
  mapStrings(value, (text) => { strings.push(text); return text; });
  const all = strings.join("\n");
  return `${JSON.stringify(mapStrings(value, (text) => dropRosterReportLines(shrinkAlerts(text, all))), null, 2)}\n`;
}

// (e) The compaction sentence of every managed role's tool-config instructions (src/runtime/host.ts) now also asks for the brief's chief-* skills to be reloaded.
export const COMPACTION_BASE = "After any context compaction, before acting, re-read your full brief at $BB_THREAD_STORAGE/brief.md and every plan, verdict or report file it names.";
export const COMPACTION_HEAD = "After any context compaction, before acting, reload in full the chief-* skills your brief names (Skill tool, or read each SKILL.md in full) and re-read your full brief at $BB_THREAD_STORAGE/brief.md and every plan, verdict or report file it names.";
/** Base instructions -> head instructions: the one sentence swapped when present (a Chief's instructions have none). */
export const withHostCompaction = (instructions: string) => {
  const parts = instructions.split(COMPACTION_BASE);
  if (parts.length > 2) throw new Error("the compaction sentence appears more than once");
  return parts.join(COMPACTION_HEAD);
};

// (f) Wave 2 moved the static Working contract, Git workflow and Fold rules, and wave 1 the Contracts to verify items, out of the rendered brief (into the
// role skills and the plan file). A transcript oracle on base briefs cannot hold those sections byte for byte any more: they are blanked on BOTH sides, so every
// other byte of every brief (mission, context, wave, source of truth, spec, verify command, report sections) still has to match. Those four sections have
// their own tests against the new text (test/loadLine.ts and the brief tests). A section runs from its heading to the next blank line.
const SLIM_SECTIONS = /^## (Working contract|Git workflow|Fold|Contracts to verify)\n[^\n]+(?:\n[^\n]+)*/gm;
export const maskSlimSections = (text: string) => text.replace(SLIM_SECTIONS, (_all, heading: string) => `## ${heading}\n<slim>`);
