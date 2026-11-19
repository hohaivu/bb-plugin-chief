import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { completeWorker, delegate, disposeAll, setup, start } from "./harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";
import { createDecisions, parseDecisions, renderDecisions, type DecisionEntry } from "../src/runtime/decisions";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts (plan wave 1, "Server-written decisions.md per Chief"): decisions.md is the one store of a Chief's or Coordinator's decisions;
// only the server writes it (chief_roster decision/todo, hand-over, chief_spawn with a moved todo); every write is serialized, bounded,
// pruned and never fails a tool call. Regression: a lost entry, an unbounded file, a read failure that overwrites the file, a write
// failure that fails chief_roster, an entry that leaks into another Chief's file.
type State = Awaited<ReturnType<typeof setup>>;
const DECISIONS_PATH = "Decisions: $BB_THREAD_STORAGE/decisions.md";
const call = (state: State, tool: string, params: object, threadId: string) => state.harness.behavior.callAgentTool(tool, params, { threadId, projectId: "proj_1" }) as Promise<string>;
const decide = (state: State, id: string, decision: object) => call(state, "chief_roster", { decision }, id);
const fileOf = (state: State, id: string) => join(state.storageRoot, id, "decisions.md");
const read = (state: State, id: string) => readFile(fileOf(state, id), "utf8");
const entries = async (state: State, id: string) => parseDecisions(await read(state, id)).entries;
const make = async (state: State) => (JSON.parse((await state.harness.behavior.runCli(["create", "--project", "proj_1", "--json"])).stdout!) as { threadId: string }).threadId;
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve)); };

describe("decisions file: format", () => {
  const MARKER = "<!-- chief-decision id=9 kind=decision thread=- todo=- at=2026-01-01T00:00:00.000Z -->";
  const HEADING = "## Todo after: reasons (generated)";
  // Regression: a raw marker or generated heading inside text or a reason drops the rest of the entry and every later entry, or invents one.
  test("parse(render(entries)) returns the entries for raw markers, headings, Why lines, escape prefixes and indented literals in text and reasons", () => {
    const input: DecisionEntry[] = [
      { id: 1, kind: "decision", at: "2026-01-01T00:00:00.000Z", text: `before\n${HEADING}\nafter\n${MARKER}\nWhy: not a reason\n\\${MARKER}\n\\\\ two\n ${MARKER}\n ${HEADING}\n Why: indented\n<!-- chief-last-id=99 -->\nlast`,
        why: `first\n${MARKER}\n${HEADING}\n\nWhy: nested\n\\kept` },
      { id: 2, kind: "owner-answer", thread: "thr_1", todo: 7, at: "2026-01-02T00:00:00.000Z", text: "second" },
      { id: 3, kind: "decision", at: "2026-01-03T00:00:00.000Z", text: HEADING },
    ];
    const text = renderDecisions(input, 3, [`- todo #7: Ship (after: ${HEADING})`, MARKER]);
    expect(parseDecisions(text)).toEqual({ last: 3, entries: input });
    expect(text.split("\n").filter((line) => line.startsWith("<!-- chief-decision"))).toHaveLength(3 + 1); // the three entries and the generated section's own marker-looking line
  });

  test("the id high-water mark survives a file with no entries and never drops below an entry's id", () => {
    expect(parseDecisions(renderDecisions([], 7))).toEqual({ last: 7, entries: [] });
    expect(parseDecisions(renderDecisions([{ id: 9, kind: "decision", at: "2026-01-01T00:00:00.000Z", text: "x" }], 4)).last).toBe(9);
  });
});

describe("decisions file: unit", () => {
  const unit = (read: () => Promise<string | null>, write = vi.fn(async () => "/p")) => {
    const warn = vi.fn();
    const ctx = {
      bb: { log: { warn } }, state: { decisionWrites: new Map() }, store: { get: () => ({ project_id: "proj_1" }) },
      todoById: { get: () => undefined }, todosForProject: { all: () => [] },
      retryWhileProvisioning: <T>(run: () => Promise<T>) => run(), readStorageFileIfPresent: read, writeStorageFile: write,
    };
    return { ...createDecisions(ctx as never), warn, write };
  };

  test("a read failure other than a missing file writes nothing and warns; no function rejects", async () => {
    const decisions = unit(async () => { throw new Error("HTTP 500: host unreachable"); });
    expect(await decisions.recordDecision("thr_1", { kind: "decision", text: "x" })).toBe(false);
    expect(await decisions.writeDecisions("thr_1", (entries) => entries)).toBe(false);
    expect(await decisions.copyDecisions("thr_1", "thr_2", "proj_1")).toBe(false);
    expect(decisions.write).not.toHaveBeenCalled();
    expect(decisions.warn).toHaveBeenCalled();
  });

  test("a failed write resolves false and warns", async () => {
    const decisions = unit(async () => null, vi.fn(async () => { throw new Error("disk full"); }));
    expect(await decisions.recordDecision("thr_1", { kind: "decision", text: "x" })).toBe(false);
    expect(decisions.warn).toHaveBeenCalled();
  });
});

describe("decisions file: chief_roster", () => {
  test("a decision is recorded with its fields; the path line is printed on every call, Chief and Coordinator", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await call(state, "chief_roster", { todo: { text: "Ship it" } }, chief);
    const out = await decide(state, chief, { text: "Use option A", why: "cheaper", threadId: "thr_9", todoId: 1 });
    expect(out.startsWith(`${DECISIONS_PATH}\n`)).toBe(true);
    expect(await call(state, "chief_roster", {}, chief)).toContain(DECISIONS_PATH);
    expect(await entries(state, chief)).toMatchObject([{ id: 1, kind: "decision", thread: "thr_9", todo: 1, text: "Use option A", why: "cheaper" }]);
    const coordinator = await make(state);
    await call(state, "chief_coordinate", {}, coordinator);
    expect((await call(state, "chief_roster", {}, coordinator)).startsWith(`${DECISIONS_PATH}\n`)).toBe(true);
    await decide(state, coordinator, { text: "Relayed answer" });
    expect(await entries(state, coordinator)).toMatchObject([{ id: 1, text: "Relayed answer" }]);
    expect(await entries(state, chief)).toHaveLength(1); // a Coordinator never writes another thread's file
  });

  test("the path line comes first and the Pending block under it survives, also when it fills the 6,000 cap", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    const small = await call(state, "chief_roster", { todo: { text: "first" } }, chief);
    expect(small).toMatch(/^Decisions: \$BB_THREAD_STORAGE\/decisions\.md\nPending:\n- todo #1: first/);
    for (let i = 0; i < 40; i++) await call(state, "chief_roster", { todo: { text: `todo ${i} ${"x".repeat(400)}` } }, chief);
    const out = await call(state, "chief_roster", {}, chief);
    expect(out.length).toBeLessThanOrEqual(6_000);
    expect(out.split("\n").slice(0, 3)).toEqual([DECISIONS_PATH, "Pending:", expect.stringMatching(/^- todo #1: first/)]);
    expect(out).toMatch(/…and \d+ more pending/);
  });

  test("a call with no todo and no decision writes nothing and prints no failure note", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    state.failWritesMatching(/decisions\.md/);
    const out = await call(state, "chief_roster", {}, chief);
    state.failWritesMatching(null);
    expect(out).not.toContain("Note: decisions.md");
    await expect(read(state, chief)).rejects.toThrow();
  });

  test("text and reason are clipped, the file stays within 8,000 characters, the oldest entries leave first, the newest stays, ids increase", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    for (let i = 1; i <= 30; i++) await decide(state, chief, { text: `n${i} ${"t".repeat(3_000)}`, why: "w".repeat(1_500) });
    const kept = await entries(state, chief);
    expect((await read(state, chief)).length).toBeLessThanOrEqual(8_000);
    expect(kept.every((entry) => entry.text.length <= 600 && entry.why!.length <= 300)).toBe(true);
    expect(kept.at(-1)!.text.startsWith("n30 ")).toBe(true);
    expect(kept.at(-1)!.id).toBe(30);
    expect(kept.map((entry) => entry.id)).toEqual([...kept.map((entry) => entry.id)].sort((a, b) => a! - b!));
    expect(kept.length).toBeLessThan(30);
    expect(kept[0]!.id).toBe(30 - kept.length + 1); // only the oldest left
  });

  test("an entry leaves when its todo closes; the after-section is rebuilt each write; a todo change twice is byte-identical", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await call(state, "chief_roster", { todo: { text: "Wait for merge", after: "PR #42 merges" } }, chief);
    await call(state, "chief_roster", { todo: { text: "Other" } }, chief);
    await decide(state, chief, { text: "Tied to one", todoId: 1 });
    await decide(state, chief, { text: "Tied to two", todoId: 2 });
    const first = await read(state, chief);
    expect(first).toContain("- todo #1: Wait for merge (after: PR #42 merges)");
    await call(state, "chief_roster", { todo: { id: 1 } }, chief);
    const again = await read(state, chief);
    await call(state, "chief_roster", { todo: { id: 1 } }, chief);
    expect(await read(state, chief)).toBe(again);
    expect(again).toBe(first);
    await call(state, "chief_roster", { todo: { id: 1, after: "PR #43 merges" } }, chief);
    expect(await read(state, chief)).toContain("after: PR #43 merges");
    await call(state, "chief_roster", { todo: { id: 1, state: "done" } }, chief);
    const closed = await read(state, chief);
    expect(closed).not.toContain("Wait for merge");
    expect((await entries(state, chief)).map((entry) => entry.text)).toEqual(["Tied to two"]);
  });

  // Regression: an id reused after its entry was pruned (a closed todo, size eviction, or a file pruned to zero entries).
  test("ids never repeat after pruning, also when the file is pruned to no entries, and copied entries take fresh ids", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await call(state, "chief_roster", { todo: { text: "Short lived" } }, chief);
    await decide(state, chief, { text: "untied" });
    await decide(state, chief, { text: "tied", todoId: 1 });
    await call(state, "chief_roster", { todo: { id: 1, state: "done" } }, chief);
    expect(await entries(state, chief)).toMatchObject([{ id: 1, text: "untied" }]);
    await decide(state, chief, { text: "after prune" });
    expect((await entries(state, chief)).map((entry) => entry.id)).toEqual([1, 3]);
    // Pruned to zero entries: the mark stays in the file.
    await call(state, "chief_roster", { todo: { text: "Only one" } }, chief);
    await decide(state, chief, { text: "last tied", todoId: 2 });
    const worker = (await delegate(state, chief, "Fix checkout totals")).threadId;
    await decide(state, chief, { text: "about worker", threadId: worker });
    await completeWorker(state, chief, worker, { skipReview: "owner: testers too costly" });
    await call(state, "chief_roster", { todo: { id: 2, state: "dropped" } }, chief);
    expect((await entries(state, chief)).map((entry) => entry.id)).toEqual([1, 3]);
    await decide(state, chief, { text: "next" });
    expect((await entries(state, chief)).map((entry) => entry.id)).toEqual([1, 3, 6]);
  });

  test("a file whose entries were all pruned keeps its id mark for the next append", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await call(state, "chief_roster", { todo: { text: "Only" } }, chief);
    await decide(state, chief, { text: "tied", todoId: 1 });
    await call(state, "chief_roster", { todo: { id: 1, state: "done" } }, chief);
    expect(await entries(state, chief)).toEqual([]);
    await decide(state, chief, { text: "next" });
    expect(await entries(state, chief)).toMatchObject([{ id: 2, text: "next" }]);
  });

  test("the generated after-section stays within 2,000 characters when the todos overflow, and says how many were left out", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    for (let i = 0; i < 30; i++) await call(state, "chief_roster", { todo: { text: `todo ${i} ${"x".repeat(150)}`, after: `PR #${i} merges` } }, chief);
    const text = await read(state, chief);
    const section = text.slice(text.indexOf("## Todo after: reasons (generated)"));
    expect(section.length).toBeLessThanOrEqual(2_000);
    expect(section).toMatch(/…and \d+ more/);
    expect(text.length).toBeLessThanOrEqual(8_000);
  });

  test("an entry leaves when its managed thread completes", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    const worker = (await delegate(state, chief, "Fix checkout totals")).threadId;
    await decide(state, chief, { text: "About the worker", threadId: worker });
    await decide(state, chief, { text: "Unknown thread", threadId: "thr_unknown" });
    expect((await entries(state, chief)).map((entry) => entry.text)).toEqual(["About the worker", "Unknown thread"]);
    await completeWorker(state, chief, worker, { skipReview: "owner: testers too costly" });
    await call(state, "chief_roster", { todo: { text: "refresh" } }, chief);
    expect((await entries(state, chief)).map((entry) => entry.text)).toEqual(["Unknown thread"]);
  });

  test("two concurrent decisions both land with distinct ids", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await Promise.all(["first", "second", "third"].map((text) => decide(state, chief, { text })));
    const kept = await entries(state, chief);
    expect(kept.map((entry) => entry.text).sort()).toEqual(["first", "second", "third"]);
    expect(new Set(kept.map((entry) => entry.id)).size).toBe(3);
  });

  test("a todoId outside the project is refused and writes nothing", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await expect(decide(state, chief, { text: "x", todoId: 99 })).rejects.toThrow("No todo #99 in this project.");
    await expect(read(state, chief)).rejects.toThrow();
  });

  test("a write failure never fails chief_roster and leaves the file as it was", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await decide(state, chief, { text: "kept" });
    const before = await read(state, chief);
    state.failWritesMatching(/decisions\.md/);
    const failed = await decide(state, chief, { text: "lost" });
    state.failWritesMatching(null);
    expect(failed).toContain("Note: decisions.md was not updated");
    expect(failed.startsWith(`${DECISIONS_PATH}\n`)).toBe(true);
    expect(await read(state, chief)).toBe(before);
  });

  // Regression: a read error whose text names a path with 404 or "not found" read as a missing file, so the write replaced the file it could not read.
  test.each([
    "EACCES: permission denied, open '/storage/thr_404/decisions.md'",
    "HTTP 500: host unreachable: path not found in cache",
  ])("an unreadable file (%s) never fails chief_roster, warns, and leaves the file as it was", async (message) => {
    let broken = false;
    let warn = vi.fn();
    const state = await setup({ seed: (ctx) => { warn = vi.spyOn(ctx.bb.log, "warn"); }, onFileRead: (path) => { if (broken && path.endsWith("decisions.md")) throw new Error(message); } });
    const chief = (await start(state)).threadId;
    await decide(state, chief, { text: "kept" });
    const before = await read(state, chief);
    broken = true;
    const failed = await decide(state, chief, { text: "lost" });
    expect(failed).toContain("Note: decisions.md was not updated");
    expect(failed.startsWith(`${DECISIONS_PATH}\n`)).toBe(true);
    expect(await read(state, chief)).toBe(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not update"));
  });
});

describe("decisions file: hand-over and spawn", () => {
  const archive = async (state: State, threadId: string) => {
    state.live.set(threadId, { ...state.live.get(threadId)!, archivedAt: Date.now() });
    await state.harness.behavior.emitThreadEvent("thread.archived", { thread: state.live.get(threadId)! });
    await state.supervisorCycle();
  };

  test("a successor gets every entry of the ended Chief, merged after its own with increasing ids", async () => {
    const state = await setup();
    const a = (await start(state)).threadId;
    const b = await make(state);
    await delegate(state, a, "Open work keeps the hand-over due"); // only a Chief with open work is handed over
    await decide(state, a, { text: "from a", why: "reason" });
    await decide(state, b, { text: "own to b" });
    await archive(state, a);
    for (let i = 0; i < 200 && (await entries(state, b).catch(() => [])).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await entries(state, b)).toMatchObject([{ id: 1, text: "own to b" }, { id: 2, text: "from a", why: "reason" }]);
    expect(await entries(state, a)).toHaveLength(1); // the predecessor's file stays as it was
  });

  test("chief_spawn with a moved todo carries only that todo's entries; without a todo the new Chief has no file; the caller's file is unchanged", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await call(state, "chief_roster", { todo: { text: "Moves" } }, chief);
    await call(state, "chief_roster", { todo: { text: "Stays" } }, chief);
    await decide(state, chief, { text: "about moved", todoId: 1 });
    await decide(state, chief, { text: "about stayed", todoId: 2 });
    await decide(state, chief, { text: "general" });
    const before = await read(state, chief);
    const idOf = (text: string) => /in thread (thr_\w+)/.exec(text)![1]!;
    const moved = idOf(await call(state, "chief_spawn", { request: "Do it", context: "Goal", todoId: 1 }, chief));
    await settle();
    expect((await entries(state, moved)).map((entry) => entry.text)).toEqual(["about moved"]);
    const bare = idOf(await call(state, "chief_spawn", { request: "Do it too", context: "Goal" }, chief));
    await settle();
    await expect(read(state, bare)).rejects.toThrow();
    expect(await read(state, chief)).toBe(before);
  });

  // Regression: copying a todo's entries although the todo was not moved (it changed owner or state while the Chief started).
  test("chief_spawn copies nothing when the todo did not move (closed while the Chief started)", async () => {
    let race = () => {};
    const state = await setup({ onSpawn: () => race() });
    const chief = (await start(state)).threadId;
    await call(state, "chief_roster", { todo: { text: "Races" } }, chief);
    await decide(state, chief, { text: "about races", todoId: 1 });
    race = () => state.db.prepare("UPDATE chief_todos SET state='done' WHERE id=1").run();
    const text = await call(state, "chief_spawn", { request: "Do it", context: "Goal", todoId: 1 }, chief);
    await settle();
    expect(text).toContain("was not moved because it changed in the meantime");
    await expect(read(state, /in thread (thr_\w+)/.exec(text)![1]!)).rejects.toThrow();
  });

  test("adopting a Chief hands the previous Chief's entries to it, as every hand-over does", async () => {
    const state = await setup();
    const chief = (await start(state)).threadId;
    await decide(state, chief, { text: "carried", why: "line one\nline two" });
    state.addLive("thr_adopted", "proj_1");
    expect((await state.harness.behavior.runCli(["adopt", "--thread", "thr_adopted"])).exitCode).toBe(0);
    for (let i = 0; i < 200 && !(await entries(state, "thr_adopted").catch(() => [])).length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await entries(state, "thr_adopted")).toMatchObject([{ id: 1, text: "carried", why: "line one\nline two" }]);
  });

  test("chief_spawn writes brief.md through the provisioning retry: a 409 longer than three tries still lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let parent = "";
    let blocked = 0;
    const state = await setup({ onStorageLocation: (id) => { if (id !== parent && blocked > 0) { blocked--; throw new Error("HTTP 409: Thread environment is unavailable"); } } });
    parent = (await start(state)).threadId;
    blocked = 4;
    const pending = call(state, "chief_spawn", { request: "Do it", context: "Goal" }, parent);
    await vi.advanceTimersByTimeAsync(20_000);
    const text = await pending;
    expect(text).not.toContain("brief.md not saved");
    expect(await readFile(join(state.storageRoot, /in thread (thr_\w+)/.exec(text)![1]!, "brief.md"), "utf8")).toContain("Handed-off task");
  });
});
