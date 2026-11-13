import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { disposeAll } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { withHostCompaction } from "./test/shrinkEdits";
import { INSTRUCTIONS_CAP, ROSTER_OTHERS_NEW, ROSTER_OTHERS_OLD, type ToolConfig, toolConfigCases, toolConfigFixture } from "./test/toolConfigFixture";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Preservation of the "Chief keeps tool search" change, runnable UNCHANGED on base 6534bea and on head (both must pass):
// every role's tools and skills, every managed-role and codex instruction (a managed role may also carry the host's reworded compaction sentence, base -> head via withHostCompaction, nothing else), every claude-code Chief line outside the one preload line, and every tool definition except chief_roster.
// The expected values are test/fixtures/tool-config-6534bea.txt, captured by running test/toolConfigFixture.ts's generator on base 6534bea, never by the code under test.
// It asserts nothing about the new schema or the new preload text: those changed-behaviour checks live in toolConfigPreservation.test.ts and toolCallStability.test.ts and fail on base on purpose.
const dir = dirname(fileURLToPath(import.meta.url));
const MARKER = "# Project rules marker";
const PRELOAD = "ToolSearch call: ";

const preloadIndexes = (text: string) => text.split("\n").flatMap((line, index) => (line.includes("ToolSearch") ? [index] : []));
const isClaudeChief = (key: string) => key.includes("| chief |") && key.includes("| claude-code |");

/** Throws unless `head` preserves `base` everywhere the change does not authorize. `head` is cloned, never mutated. */
export function assertPreserved(base: ToolConfig, original: ToolConfig) {
  const fail = (what: string): never => { throw new Error(`not preserved: ${what}`); };
  const head = structuredClone(original);
  if (Object.keys(head.catalog).join() !== Object.keys(base.catalog).join()) fail("tool names or order");
  for (const name of Object.keys(base.catalog)) {
    const now = head.catalog[name]!;
    // chief_roster alone may differ: the delta is removed here (a no-op on base) so that any other edit to it still fails; its exact shape is checked by compareToolConfig.
    if (name === "chief_roster") {
      delete (now.inputSchema.properties as Record<string, unknown>)["includeOthers"];
      now.description = now.description.replace(ROSTER_OTHERS_NEW, ROSTER_OTHERS_OLD);
    }
    if (JSON.stringify(now) !== JSON.stringify(base.catalog[name])) fail(`catalog ${name}`);
  }
  if (head.entries.length !== base.entries.length) fail("entry count");
  head.entries.forEach((entry, index) => {
    const old = base.entries[index]!;
    if (entry.key !== old.key) fail(`key ${old.key}`);
    if (JSON.stringify(entry.tools) !== JSON.stringify(old.tools)) fail(`${old.key}: tools`);
    if (JSON.stringify(entry.skills) !== JSON.stringify(old.skills)) fail(`${old.key}: skills`);
    if (!isClaudeChief(old.key)) {
      if (entry.instructions !== old.instructions && entry.instructions !== withHostCompaction(old.instructions!)) fail(`${old.key}: instructions`);
      return;
    }
    // A claude-code Chief: the one preload line may change, so it is cut out of both texts; its position and its lead-in text are kept, and the rest up to the project rules is byte for byte.
    const [was, now] = [old.instructions!, entry.instructions ?? ""];
    const [wasAt, nowAt] = [preloadIndexes(was), preloadIndexes(now)];
    if (wasAt.length !== 1 || nowAt.length !== 1 || wasAt[0] !== nowAt[0]) fail(`${old.key}: preload line count or position`);
    const [wasLines, nowLines] = [was.split("\n"), now.split("\n")];
    const lead = (line: string) => line.slice(0, line.indexOf(PRELOAD) + PRELOAD.length);
    if (!wasLines[wasAt[0]!]!.includes(PRELOAD) || lead(nowLines[nowAt[0]!]!) !== lead(wasLines[wasAt[0]!]!)) fail(`${old.key}: preload lead-in`);
    wasLines.splice(wasAt[0]!, 1);
    nowLines.splice(nowAt[0]!, 1);
    const [wasRest, nowRest] = [wasLines.join("\n"), nowLines.join("\n")];
    const [wasCut, nowCut] = [wasRest.indexOf(MARKER), nowRest.indexOf(MARKER)];
    if (wasCut < 0 || wasCut !== nowCut || nowRest.slice(0, nowCut) !== wasRest.slice(0, wasCut)) fail(`${old.key}: text before the project rules`);
    // The project rules follow, cut at the SDK limit: head must be its own text before the rules plus the generator's rules, capped (the longer preload line moves the cut, so no byte is compared with base's tail).
    const rules = toolConfigCases.find((candidate) => old.key.startsWith(`${candidate.label} |`))!.rules;
    const text = entry.instructions!;
    if (text !== `${text.slice(0, text.indexOf(MARKER))}${rules}`.slice(0, INSTRUCTIONS_CAP)) fail(`${old.key}: project rules or cap`);
  });
}

describe("tool config preservation against base 6534bea (passes on base and on head)", () => {
  const load = async () => ({
    base: JSON.parse(await readFile(join(dir, "test", "fixtures", "tool-config-6534bea.txt"), "utf8")) as ToolConfig,
    head: JSON.parse(await toolConfigFixture()) as ToolConfig,
  });
  const mutated = async (edit: (head: ToolConfig) => void) => {
    const { base, head } = await load();
    edit(head);
    return () => assertPreserved(base, head);
  };
  const find = (config: ToolConfig, part: string) => config.entries.find((entry) => entry.key.includes(part))!;

  test("tools, skills, managed-role preload and instructions, codex instructions and the catalog (apart from chief_roster) are preserved", async () => {
    const { base, head } = await load();
    expect(() => assertPreserved(base, head)).not.toThrow();
  });

  test("the comparison is not vacuous: base is the +chief keyword form, every role and provider is present", async () => {
    const { base } = await load();
    const chiefs = base.entries.filter((entry) => isClaudeChief(entry.key));
    expect(chiefs).toHaveLength(8);
    for (const entry of chiefs) expect(entry.instructions!.split("\n").filter((line) => line.includes('query "+chief", max_results')), entry.key).toHaveLength(1);
    for (const role of ["chief", "worker", "plan worker", "designer", "tester", "spec-writer", "reviewer", "planner", "researcher", "advisor"]) {
      for (const provider of ["codex", "claude-code"]) expect(base.entries.some((entry) => entry.key.includes(`| ${role} | ${provider} |`)), `${role} ${provider}`).toBe(true);
    }
    const managed = base.entries.filter((entry) => entry.key.includes("| claude-code |") && !entry.key.includes("| chief |") && entry.tools.length);
    expect(managed.length).toBeGreaterThan(30);
    for (const entry of managed) expect(preloadIndexes(entry.instructions!), entry.key).toHaveLength(1);
    for (const entry of base.entries.filter((candidate) => candidate.key.includes("| codex |"))) expect(entry.instructions ?? "", entry.key).not.toContain("ToolSearch");
    expect(base.entries.some((entry) => entry.skills.length > 0)).toBe(true);
    expect(base.entries.filter((entry) => (entry.instructions ?? "").length === INSTRUCTIONS_CAP).length).toBeGreaterThan(0);
  });

  describe("negative controls: any other difference fails", () => {
    test("a skill dropped from a role", async () => {
      expect(await mutated((head) => { const entry = find(head, "| chief | codex |"); entry.skills = entry.skills.slice(1); })).toThrow(": skills");
    });
    test("a tool dropped from a managed role", async () => {
      expect(await mutated((head) => { const entry = find(head, "| worker | claude-code |"); entry.tools = entry.tools.slice(1); })).toThrow(": tools");
    });
    test("two tools swapped on a plain Chief", async () => {
      expect(await mutated((head) => { const entry = find(head, "| chief | claude-code |"); [entry.tools[0], entry.tools[1]] = [entry.tools[1]!, entry.tools[0]!]; })).toThrow(": tools");
    });
    test("a managed worker's preload line loses a name", async () => {
      expect(await mutated((head) => { const entry = find(head, "| worker | claude-code |"); entry.instructions = entry.instructions!.replace(/select:\S+/, "select:mcp__bb-bridge__chief_log"); })).toThrow(": instructions");
    });
    test("a managed worker's preload line moved to the end", async () => {
      expect(await mutated((head) => {
        const entry = find(head, "| worker | claude-code |");
        const lines = entry.instructions!.split("\n");
        const [line] = lines.splice(preloadIndexes(entry.instructions!)[0]!, 1);
        entry.instructions = [...lines, line].join("\n");
      })).toThrow(": instructions");
    });
    test("a non-claude-code instruction changed (worker and plain Chief)", async () => {
      expect(await mutated((head) => { find(head, "| worker | codex |").instructions += "\n- extra"; })).toThrow(": instructions");
      expect(await mutated((head) => { find(head, "| chief | codex |").instructions += "\n- extra"; })).toThrow(": instructions");
    });
    test("a preload line added to a codex role", async () => {
      expect(await mutated((head) => { const entry = find(head, "| reviewer | codex |"); entry.instructions = `${entry.instructions}\nToolSearch call: select:mcp__bb-bridge__chief_log`; })).toThrow(": instructions");
    });
    test("a claude-code Chief: a core rule outside the preload line changed", async () => {
      expect(await mutated((head) => { const entry = find(head, "short rules | chief | claude-code |"); entry.instructions = entry.instructions!.replace("never edits code", "edits code"); })).toThrow(": text before the project rules");
    });
    test("a claude-code Chief: the preload line moved or duplicated or removed", async () => {
      const moved = await mutated((head) => {
        const entry = find(head, "short rules | chief | claude-code |");
        const lines = entry.instructions!.split("\n");
        const [line] = lines.splice(preloadIndexes(entry.instructions!)[0]!, 1);
        lines.splice(preloadIndexes(entry.instructions!)[0]! + 1, 0, line!);
        entry.instructions = lines.join("\n");
      });
      const duplicated = await mutated((head) => { const entry = find(head, "short rules | chief | claude-code |"); const line = entry.instructions!.split("\n")[preloadIndexes(entry.instructions!)[0]!]!; entry.instructions = entry.instructions!.replace(line, `${line}\n${line}`); });
      const removed = await mutated((head) => { const entry = find(head, "short rules | chief | claude-code |"); entry.instructions = entry.instructions!.split("\n").filter((line) => !line.includes("ToolSearch")).join("\n"); });
      for (const run of [moved, duplicated, removed]) expect(run).toThrow(": preload line count or position");
    });
    test("a claude-code Chief: the preload lead-in reworded", async () => {
      expect(await mutated((head) => { const entry = find(head, "short rules | chief | claude-code |"); entry.instructions = entry.instructions!.replace(PRELOAD, "ToolSearch call (now): "); })).toThrow(": preload lead-in");
    });
    test("a claude-code Chief: a project-rules byte changed or the rules cut short", async () => {
      expect(await mutated((head) => { const entry = find(head, "short rules | chief | claude-code |"); entry.instructions = entry.instructions!.replace("Keep rules small.", "Keep rules smalX."); })).toThrow(": project rules or cap");
      expect(await mutated((head) => { const entry = find(head, "short rules | chief | claude-code |"); entry.instructions = entry.instructions!.slice(0, -1); })).toThrow(": project rules or cap");
      expect(await mutated((head) => { const entry = find(head, "worst case | chief | claude-code |"); entry.instructions = `${entry.instructions!.slice(0, -1)}X`; })).toThrow(": project rules or cap");
      expect(await mutated((head) => { const entry = find(head, "worst case | chief | claude-code |"); entry.instructions = entry.instructions!.slice(0, -1); })).toThrow(": project rules or cap");
    });
    test("a tool definition other than chief_roster edited", async () => {
      expect(await mutated((head) => { head.catalog["chief_review"]!.description += " Extra."; })).toThrow("catalog chief_review");
      expect(await mutated((head) => { (head.catalog["chief_complete"]!.inputSchema.properties as Record<string, unknown>)["extra"] = { description: "x" }; })).toThrow("catalog chief_complete");
    });
    test("chief_roster edited beyond the roster delta", async () => {
      expect(await mutated((head) => { head.catalog["chief_roster"]!.description = head.catalog["chief_roster"]!.description.replace("leave them unless the user asks", "act on them freely"); })).toThrow("catalog chief_roster");
      expect(await mutated((head) => { (head.catalog["chief_roster"]!.inputSchema.properties as Record<string, unknown>)["includeAll"] = { type: "boolean" }; })).toThrow("catalog chief_roster");
    });
    test("a tool added to or removed from the catalog", async () => {
      expect(await mutated((head) => { head.catalog["chief_extra"] = head.catalog["chief_log"] ?? head.catalog["chief_roster"]!; })).toThrow("tool names or order");
      expect(await mutated((head) => { delete head.catalog["chief_stop"]; })).toThrow("tool names or order");
    });
  });
});
