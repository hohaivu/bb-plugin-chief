import { clip, fitLines } from "../core/text";
import { terminal } from "../types";
import type { TodoRow } from "../tools/shapes";
import type { Ctx } from "./context";

export interface DecisionEntry {
  id?: number;
  kind: "decision" | "owner-answer";
  thread?: string;
  todo?: number;
  at: string;
  text: string;
  why?: string;
}
type DecisionInput = { kind: DecisionEntry["kind"]; text: string; why?: string; threadId?: string; todoId?: number };

const FILE = "decisions.md";
const HEADER = "# Decisions\n";
const AFTER_HEADING = "## Todo after: reasons (generated)";
const MARKER = /^<!-- chief-decision id=(\d+) kind=(decision|owner-answer) thread=(\S+) todo=(\S+) at=(\S+) -->$/;
const MAX_FILE = 8_000;
const MAX_AFTER = 2_000;

/** An entry's text line that would read as structure (a chief- comment, the generated heading, a Why line, or the escape itself) gets a leading backslash. */
const STRUCTURAL = /^(\\|<!-- chief-|## Todo after|Why: )/;
const LAST = /^<!-- chief-last-id=(\d+) -->$/;

/** The entries of a decisions.md, and the highest id it ever held (kept after pruning). Everything from the generated heading on is dropped (it is rebuilt), and lines before the first marker are ignored. */
export function parseDecisions(text: string) {
  const entries: (DecisionEntry & { body: string[] })[] = [];
  let last = 0;
  for (const line of text.split("\n")) {
    if (line === AFTER_HEADING) break;
    const marker = MARKER.exec(line);
    if (marker) {
      const todo = Number(marker[4]);
      entries.push({ id: Number(marker[1]), kind: marker[2] as DecisionEntry["kind"], thread: marker[3] === "-" ? undefined : marker[3],
        todo: marker[4] === "-" || Number.isNaN(todo) ? undefined : todo, at: marker[5], text: "", body: [] });
    } else if (LAST.test(line)) last = Number(LAST.exec(line)![1]);
    else entries.at(-1)?.body.push(line);
  }
  return {
    last: Math.max(last, ...entries.map((entry) => entry.id!)),
    entries: entries.map(({ body, ...entry }) => {
      while (body.length && !body.at(-1)!.trim()) body.pop();
      const why: string[] = [];
      while (body.at(-1)?.startsWith("Why: ")) why.unshift(body.pop()!.slice(5));
      return { ...entry, text: body.map((line) => line.startsWith("\\") ? line.slice(1) : line).join("\n"), ...(why.length ? { why: why.join("\n") } : {}) };
    }),
  };
}

/** The file text for entries that all have ids, the id high-water mark, plus the generated after-section. Text and reasons survive parseDecisions
 * except trailing blank lines: structural text lines are escaped, and every reason line carries its own Why prefix. */
export function renderDecisions(entries: DecisionEntry[], last: number, afterLines: string[] = []) {
  const after = afterLines.length ? `\n${AFTER_HEADING}\n${afterLines.join("\n")}\n` : "";
  const render = (entry: DecisionEntry) => {
    const text = entry.text.split("\n").map((line) => STRUCTURAL.test(line) ? `\\${line}` : line).join("\n");
    const why = entry.why === undefined ? "" : `${entry.why.split("\n").map((line) => `Why: ${line}`).join("\n")}\n`;
    return `<!-- chief-decision id=${entry.id} kind=${entry.kind} thread=${entry.thread ?? "-"} todo=${entry.todo ?? "-"} at=${entry.at} -->\n${text}\n${why}\n`;
  };
  return `${HEADER}<!-- chief-last-id=${last} -->\n\n${entries.map(render).join("")}${after}`;
}

export function createDecisions(ctx: Ctx) {
  const { bb, store, todoById, todosForProject } = ctx;

  /** One read-modify-write of the owner's decisions.md, serialized per owner. Never rejects: resolves false (and logs) when the file was not written. */
  function writeDecisions(ownerId: string, change: (entries: DecisionEntry[]) => DecisionEntry[], projectId?: string): Promise<boolean> {
    const step = async () => {
      try {
        return await ctx.retryWhileProvisioning(async () => {
          const project = projectId ?? store.get(ownerId)?.project_id;
          // A read failure other than "missing" throws here: writing over a file we could not read would lose its entries.
          const parsed = parseDecisions((await ctx.readStorageFileIfPresent(ownerId, FILE)) ?? "");
          // New entries (also copied ones) take ids above the file's high-water mark, which pruning never lowers.
          let last = parsed.last;
          let entries = change(parsed.entries).map((entry) => entry.id === undefined ? { ...entry, id: ++last } : entry);
          entries = entries.filter((entry) => {
            if (entry.thread && terminal(store.get(entry.thread)?.state ?? "")) return false;
            if (entry.todo === undefined || !project) return true;
            return (todoById.get(entry.todo, project) as TodoRow | undefined)?.state === "open";
          });
          const todos = project ? (todosForProject.all(project) as TodoRow[]).filter((todo) => todo.chief_thread_id === ownerId && todo.after) : [];
          const afterLines = fitLines(todos.map((todo) => ctx.todoLine(todo, ownerId)), MAX_AFTER - AFTER_HEADING.length - 3).lines;
          // The newest entry always stays: an entry is far smaller than the cap.
          while (entries.length > 1 && renderDecisions(entries, last, afterLines).length > MAX_FILE) entries = entries.slice(1);
          await ctx.writeStorageFile(ownerId, FILE, renderDecisions(entries, last, afterLines));
          return true;
        });
      } catch (error) {
        bb.log.warn(`Could not update ${ownerId}'s ${FILE}: ${String(error)}`);
        return false;
      }
    };
    const run = (ctx.state.decisionWrites.get(ownerId) ?? Promise.resolve()).then(step);
    ctx.state.decisionWrites.set(ownerId, run);
    void run.then(() => { if (ctx.state.decisionWrites.get(ownerId) === run) ctx.state.decisionWrites.delete(ownerId); });
    return run;
  }

  /** Appends one entry to the owner's file. Never rejects. */
  function recordDecision(ownerId: string, input: DecisionInput) {
    const why = input.why?.trim();
    const thread = input.threadId?.replace(/\s/g, "");
    const entry: DecisionEntry = {
      kind: input.kind, at: new Date().toISOString(), text: clip(input.text.trim(), 600),
      ...(thread ? { thread } : {}), ...(input.todoId === undefined ? {} : { todo: input.todoId }),
      ...(why ? { why: clip(why, 300) } : {}),
    };
    return writeDecisions(ownerId, (entries) => [...entries, entry]);
  }

  /** Copies entries of one owner's file into another's own storage: all of them, or only those tied to todoId. Writes nothing for an empty selection. Never rejects. */
  async function copyDecisions(fromId: string, toId: string, projectId: string, todoId?: number) {
    try {
      await ctx.state.decisionWrites.get(fromId); // never rejects
      const source = parseDecisions((await ctx.readStorageFileIfPresent(fromId, FILE)) ?? "").entries
        .filter((entry) => todoId === undefined || entry.todo === todoId);
      if (!source.length) return true;
      return await writeDecisions(toId, (entries) => [...entries, ...source.map(({ id: _, ...entry }) => entry)], projectId);
    } catch (error) {
      bb.log.warn(`Could not copy ${fromId}'s ${FILE} to ${toId}: ${String(error)}`);
      return false;
    }
  }

  return { writeDecisions, recordDecision, copyDecisions };
}
