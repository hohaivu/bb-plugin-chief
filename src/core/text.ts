export const MAX_ALERT_LENGTH = 3_000;

export function clip(value: string, limit = MAX_ALERT_LENGTH) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** The longest prefix of lines that fits budget characters (newlines included), then an "…and N more"
 * line when some were left out and the marker itself fits. cut says whether anything was left out. */
export function fitLines(lines: string[], budget: number, marker = true) {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    used += line.length + 1;
    kept.push(line);
  }
  const cut = kept.length < lines.length;
  const more = () => `  …and ${lines.length - kept.length} more`;
  if (cut && marker) while (kept.length && used + more().length + 1 > budget) used -= kept.pop()!.length + 1;
  return { lines: cut && marker && used + more().length + 1 <= budget ? [...kept, more()] : kept, cut };
}

export type RecordedCommand = { command: string; exitCode: number | null; status: string };

/** Longest command text an alert or prompt shows; the full report file keeps the whole command. */
export const COMMAND_EXCERPT = 120;

/** Lines for the commands BB recorded, failures first. recorded null means the read failed, [] means none ran.
 * The header always stays; command lines stop at `budget` characters with an "…and N more" line, and each
 * command shows at most COMMAND_EXCERPT characters unless full is set. */
export function recordedLines(recorded: RecordedCommand[] | null, budget = Infinity, full = false) {
  if (recorded === null) return ["Recorded: could not read the event log (see the plugin log)"];
  if (!recorded.length) return ["Recorded: none recorded"];
  const failed = (c: RecordedCommand) => c.exitCode !== null && c.exitCode !== 0;
  const lines = [...recorded.filter(failed), ...recorded.filter((c) => !failed(c))]
    .map((c) => `  ${full ? c.command : clip(c.command, COMMAND_EXCERPT)} → exit ${c.exitCode ?? c.status}`);
  return [`Recorded (last ${recorded.length} commands): ${recorded.filter(failed).length} non-zero exit`, ...fitLines(lines, budget).lines];
}

/** Like clip(), but elides the middle instead of the tail: a long brief's opening
 * (the mission) and its trailing sections (Context, where a plan file path now
 * lives) both survive the cut, instead of the tail-only clip() dropping whichever
 * section comes last. */
export function clipMiddle(value: string, limit: number) {
  const marker = "\n…\n";
  if (value.length <= limit || limit <= marker.length) return clip(value, limit);
  const room = limit - marker.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

export function bullets(values?: string[]) {
  return values?.length ? values.map((value) => `- ${value}`).join("\n") : "- None stated.";
}
