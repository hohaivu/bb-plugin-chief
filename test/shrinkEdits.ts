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
      const start = line.indexOf("The reviewer ");
      if (start !== -1 && line.length - start > CLIPPED && shape(line.slice(start, start + CLIPPED - 1)) === shape(prefix) && !/thr_\d/.test(line.slice(start + CLIPPED - 1))) {
        renamed.add(prefix + line.slice(start + CLIPPED - 1));
      }
    }
    const wholes = exact.size ? exact : renamed;
    if (wholes.size !== 1) throw new Error(`expected exactly one whole action for a clipped line, found ${wholes.size}: ${clipped.slice(0, 80)}`);
    return [...wholes][0]!;
  };
  return text.split("\n").map((line) => (line.length === CLIPPED && line.endsWith("…") && /^The reviewer /.test(line) ? wholeOf(line) : line)).join("\n");
}

/** Base alert blocks (text from `[Chief lifecycle alert]` to the next blank line or `---`) whose action was clipped lose their report-file pointer. */
export function dropPointerOfClippedActions(base: string, expanded: string): string {
  const baseBlocks = base.split(/(?=\[Chief lifecycle alert\])/);
  const expandedBlocks = expanded.split(/(?=\[Chief lifecycle alert\])/);
  if (baseBlocks.length !== expandedBlocks.length) throw new Error("block count changed by the expansion");
  return expandedBlocks.map((block, index) => {
    if (block === baseBlocks[index]) return block;
    if (/\(clipped|…and \d+ more/.test(block)) throw new Error("an alert clipped for another reason keeps its report file");
    const pointer = block.split("\n").filter((line) => /^Full report: \S+\.md$/.test(line));
    if (pointer.length !== 1) throw new Error(`expected exactly one Full report pointer, found ${pointer.length}`);
    return block.replace(`${pointer[0]}\n`, "");
  }).join("");
}

/** `otherBaseTexts`: further base-recorded fixtures that hold the same action unclipped (matched by the exact clipped prefix, thread ids included). */
export const shrinkAlerts = (base: string, ...otherBaseTexts: string[]) => dropPointerOfClippedActions(base, expandClippedActions(base, ...otherBaseTexts));
