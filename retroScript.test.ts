import { describe, expect, test } from "vitest";
import { RETRO_SCRIPT } from "./src/observe/retro";

// Contracts (docs/specs/observability.md, "Judge workflow"): the judge's result schemas use only the workflows host's safe schema subset,
// a nullable value is a type array, and when every call fails the run error names what agent() raised.
const ALLOWED = new Set(["$comment", "additionalProperties", "const", "default", "deprecated", "description", "enum", "examples", "exclusiveMaximum", "exclusiveMinimum", "items", "maxItems", "maxLength", "maxProperties", "maximum", "minItems", "minLength", "minProperties", "minimum", "multipleOf", "nullable", "properties", "readOnly", "required", "title", "type", "writeOnly"]);

type Schema = Record<string, any>;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const jobs = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: i === n - 1 ? "communication" : "thread", prompt: `job ${i}` }));
const parallel = (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((thunk) => thunk().catch(() => null)));

/** Runs the script body the way the host does: only args, agent, parallel and budget exist. */
function run(agent: (prompt: string, opts: any) => Promise<unknown>, jobCount = 8) {
  const body = RETRO_SCRIPT.replace("export const meta", "const meta");
  return new AsyncFunction("args", "agent", "parallel", "budget", body)({ cap: 9, models: {}, preamble: "p", jobs: jobs(jobCount) }, agent, parallel, () => ({ maxAgentCalls: 100 })) as Promise<any>;
}

async function schemas() {
  const seen: Schema[] = [];
  await run(async (_prompt, opts) => { seen.push(opts.schema); return { ok: true }; }, 2);
  return { thread: seen[0]!, comm: seen[1]! };
}

function keysOf(schema: Schema, path = "schema"): string[] {
  const bad = Object.keys(schema).filter((key) => !ALLOWED.has(key)).map((key) => `${path}.${key}`);
  const children: [Schema, string][] = [];
  for (const [name, child] of Object.entries(schema.properties ?? {})) children.push([child as Schema, `${path}.properties.${name}`]);
  if (schema.items && typeof schema.items === "object") children.push([schema.items, `${path}.items`]);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") children.push([schema.additionalProperties, `${path}.additionalProperties`]);
  return [...bad, ...children.flatMap(([child, childPath]) => keysOf(child, childPath))];
}

/** A hand check of the subset the judge schemas use: type (string or array), enum, required, additionalProperties false, properties, items. */
function accepts(schema: Schema, value: unknown): boolean {
  const kinds = [schema.type].flat();
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!kinds.includes(kind)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (kind === "array") return (value as unknown[]).every((item) => accepts(schema.items, item));
  if (kind !== "object") return true;
  const object = value as Record<string, unknown>, properties = schema.properties ?? {};
  if ((schema.required ?? []).some((key: string) => !(key in object))) return false;
  if (schema.additionalProperties === false && Object.keys(object).some((key) => !(key in properties))) return false;
  return Object.entries(properties).every(([key, child]) => !(key in object) || accepts(child as Schema, object[key]));
}

const lesson = { surface: "worker-brief", rule: "r", missingOrWrong: "m", prevents: "p", recurrence: "recurs", existingInstruction: null, evidence: ["thr_1#1"] };
const signals = { briefGapBlock: true, askedTwice: false, unclearBriefRounds: null, userWordsLost: null };
const handoff = { threadId: "thr_1", label: "clear", reason: "r", signals, evidence: [] };

describe("retro judge schemas", () => {
  test("the script has no combinator, $ref, pattern or format, and every schema key is in the host's allow-list", async () => {
    expect(RETRO_SCRIPT).not.toMatch(/anyOf|oneOf|allOf|\$ref|pattern|format/);
    const { thread, comm } = await schemas();
    expect(keysOf(thread)).toEqual([]);
    expect(keysOf(comm)).toEqual([]);
  });

  test("a thread's lesson is null or a full lesson, existingInstruction is a string or null, and the required lists are unchanged", async () => {
    const { thread } = await schemas();
    const result = (over: Record<string, unknown>) => ({ threadId: "thr_1", scores: [{ scorer: "efficiency", label: "highly_efficient", reason: "r", evidence: [] }], lesson: null, ...over });
    expect(accepts(thread, result({}))).toBe(true);
    expect(accepts(thread, result({ lesson }))).toBe(true);
    expect(accepts(thread, result({ lesson: { ...lesson, existingInstruction: "Verify first." } }))).toBe(true);
    expect(accepts(thread, result({ lesson: { ...lesson, existingInstruction: 3 } }))).toBe(false);
    expect(accepts(thread, result({ lesson: { ...lesson, recurrence: "often" } }))).toBe(false);
    expect(accepts(thread, result({ lesson: { ...lesson, extra: 1 } }))).toBe(false);
    expect(accepts(thread, result({ lesson: { surface: "worker-brief" } }))).toBe(false);
    expect(accepts(thread, { threadId: "thr_1", scores: [] })).toBe(false);
    expect(thread.required).toEqual(["threadId", "scores", "lesson"]);
    expect(thread.additionalProperties).toBe(false);
    expect(thread.properties.lesson.required).toEqual(["surface", "rule", "missingOrWrong", "prevents", "recurrence", "existingInstruction", "evidence"]);
    expect(thread.properties.lesson.properties.recurrence.enum).toEqual(["recurs", "severe"]);
  });

  test("each handoff signal is true, false or null; the communication lessons are objects and never null", async () => {
    const { comm } = await schemas();
    expect(accepts(comm, { handoffs: [handoff], lessons: [lesson] })).toBe(true);
    for (const value of [true, false, null]) expect(accepts(comm, { handoffs: [{ ...handoff, signals: { ...signals, askedTwice: value } }], lessons: [] })).toBe(true);
    expect(accepts(comm, { handoffs: [{ ...handoff, signals: { ...signals, askedTwice: "yes" } }], lessons: [] })).toBe(false);
    expect(accepts(comm, { handoffs: [{ ...handoff, signals: { briefGapBlock: true } }], lessons: [] })).toBe(false);
    expect(accepts(comm, { handoffs: [], lessons: [null] })).toBe(false);
    expect(accepts(comm, { handoffs: [] })).toBe(false);
    expect(comm.required).toEqual(["handoffs", "lessons"]);
    expect(comm.additionalProperties).toBe(false);
  });
});

describe("retro judge errors", () => {
  test("when every call throws, the error carries the agent's message and no pointer to failed calls", async () => {
    const error = await run(async () => { throw new Error("agent options.schema.properties.lesson.anyOf is not supported"); }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("All 8 judge calls failed:");
    expect(error.message).toContain("agent options.schema.properties.lesson.anyOf is not supported");
    expect(error.message).not.toContain("See the failed calls");
    expect(error.message.match(/is not supported/g)).toHaveLength(1); // distinct errors only
  });

  test("many long distinct errors are cut so the whole message stays near 650 characters", async () => {
    let n = 0;
    const error = await run(async () => { throw new Error(`error ${n++} ${"x".repeat(500)}`); }).catch((e: Error) => e);
    expect(error.message).toContain("All 8 judge calls failed: error 0");
    expect(error.message.length).toBeLessThanOrEqual(650);
  });

  test("when every call returns null, the error says the calls returned no result", async () => {
    const error = await run(async () => null).catch((e: Error) => e);
    expect(error.message).toBe("All 8 judge calls returned no result.");
  });

  test("with one success and the rest throwing, the result keeps job order, maps the communication job and counts the lost calls", async () => {
    const result = await run(async (prompt) => { if (prompt.endsWith("job 2")) return { id: "third" }; throw new Error("boom"); });
    expect(result.lost).toBe(7);
    expect(result.threads).toEqual([null, null, { id: "third" }, null, null, null, null]);
    expect(result.communication).toBeNull();
    const withComm = await run(async (prompt) => (prompt.endsWith("job 7") ? { id: "comm" } : null));
    expect(withComm).toEqual({ threads: Array(7).fill(null), communication: { id: "comm" }, lost: 7 });
  });
});
