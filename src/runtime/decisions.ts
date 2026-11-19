import { clip, fitLines } from "../core/text";
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
const ENDED = ["complete", "archived", "deleted"];

/** The entries of a decisions.md; everything from the generated heading on is dropped (it is rebuilt), and lines before the first marker are ignored. */
export function parseDecisions(text: string): DecisionEntry[] {
  const entries: (DecisionEntry & { body: string[] })[] = [];
  for (const line of text.split("\n")) {
    if (line === AFTER_HEADING) break;
    const marker = MARKER.exec(line);
    if (marker) {
      const todo = Number(marker[4]);
      entries.push({ id: Number(marker[1]), kind: marker[2] as DecisionEntry["kind"], thread: marker[3] === "-" ? undefined : marker[3],
        todo: marker[4] === "-" || Number.isNaN(todo) ? undefined : todo, at: marker[5], text: "", body: [] });
    } else entries.at(-1)?.body.push(line);
  }
  return entries.map(({ body, ...entry }) => {
    while (body.length && !body.at(-1)!.trim()) body.pop();
    const why = body.at(-1)?.startsWith("Why: ") ? body.pop()!.slice(5) : undefined;
    return { ...entry, text: body.join("\n"), ...(why === undefined ? {} : { why }) };
  });
}

/** The file text for entries that all have ids, plus the generated after-section. */
export function renderDecisions(entries: DecisionEntry[], afterLines: string[] = []) {
  const after = afterLines.length ? `\n${AFTER_HEADING}\n${afterLines.join("\n")}\n` : "";
  const render = (entry: DecisionEntry) =>
    `<!-- chief-decision id=${entry.id} kind=${entry.kind} thread=${entry.thread ?? "-"} todo=${entry.todo ?? "-"} at=${entry.at} -->\n${entry.text}\n${entry.why === undefined ? "" : `Why: ${entry.why}\n`}\n`;
  return `${HEADER}\n${entries.map(render).join("")}${after}`;
}

/** A line that would parse as structure (marker, generated heading, Why line) gets a leading space, so parse(render(x)) returns x. */
const escapeLines = (text: string) => text.split("\n").map((line) => MARKER.test(line) || line === AFTER_HEADING || line.startsWith("Why: ") ? ` ${line}` : line).join("\n");

export function createDecisions(ctx: Ctx) {
  const { bb, store, todoById, todosForProject } = ctx;

  /** One read-modify-write of the owner's decisions.md, serialized per owner. Never rejects: resolves false (and logs) when the file was not written. */
  function writeDecisions(ownerId: string, change: (entries: DecisionEntry[]) => DecisionEntry[], projectId?: string): Promise<boolean> {
    const step = async () => {
      try {
        return await ctx.retryWhileProvisioning(async () => {
          const project = projectId ?? store.get(ownerId)?.project_id;
          // A read failure other than "missing" throws here: writing over a file we could not read would lose its entries.
          let entries = change(parseDecisions((await ctx.readStorageFileIfPresent(ownerId, FILE)) ?? ""));
          let next = Math.max(0, ...entries.map((entry) => entry.id ?? 0)) + 1;
          entries = entries.map((entry) => entry.id === undefined ? { ...entry, id: next++ } : entry);
          entries = entries.filter((entry) => {
            if (entry.thread && ENDED.includes(store.get(entry.thread)?.state ?? "")) return false;
            if (entry.todo === undefined || !project) return true;
            return (todoById.get(entry.todo, project) as TodoRow | undefined)?.state === "open";
          });
          const todos = project ? (todosForProject.all(project) as TodoRow[]).filter((todo) => todo.chief_thread_id === ownerId && todo.after) : [];
          const afterLines = fitLines(todos.map((todo) => ctx.todoLine(todo, ownerId)), MAX_AFTER - AFTER_HEADING.length - 3).lines;
          // The newest entry always stays: an entry is far smaller than the cap.
          while (entries.length > 1 && renderDecisions(entries, afterLines).length > MAX_FILE) entries = entries.slice(1);
          await ctx.writeStorageFile(ownerId, FILE, renderDecisions(entries, afterLines));
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
    const why = input.why?.replace(/\s*\n\s*/g, " ").trim();
    const thread = input.threadId?.replace(/\s/g, "");
    const entry: DecisionEntry = {
      kind: input.kind, at: new Date().toISOString(), text: clip(escapeLines(input.text.trim()), 600),
      ...(thread ? { thread } : {}), ...(input.todoId === undefined ? {} : { todo: input.todoId }),
      ...(why ? { why: clip(why, 300) } : {}),
    };
    return writeDecisions(ownerId, (entries) => [...entries, entry]);
  }

  /** Copies entries of one owner's file into another's own storage: all of them, or only those tied to todoId. Writes nothing for an empty selection. Never rejects. */
  async function copyDecisions(fromId: string, toId: string, projectId: string, todoId?: number) {
    try {
      await ctx.state.decisionWrites.get(fromId); // never rejects
      const source = parseDecisions((await ctx.readStorageFileIfPresent(fromId, FILE)) ?? "")
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
