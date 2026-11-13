import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { disposeAll } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { CHIEF_HOST_ORDER, INCLUDE_OTHERS_PROPERTY, type ToolConfig, compareToolConfig, toolConfigFixture } from "./test/toolConfigFixture";
import { ATTACH_DEFINITION, EVIDENCE_ONLY_PROPERTY, acceptCoreRuleTrim } from "./test/specLaneWording";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contract C13 (plan wave 1 "Only the Spec Writer edits docs/ everywhere", docs/specs/plan-chains.md): the tool configuration of every role changes in exactly three places
// against base 9689364: the chief_delegate `kind` clause, the chief_complete `skipReview` clause, and Chief's core-rule Tests/Skips lines; plus the one #213 delta: a plain
// Chief gains chief_attach right after chief_coordinate (exact definition). Delta of the "Chief keeps tool search" change (docs/specs/tool-call-stability.md, work-list.md): chief_roster gains
// the one optional boolean `includeOthers` plus one description clause, and a plain Chief's claude-code preload line `query "+chief", max_results N` becomes `select:` plus every returned tool in
// the host's pinned order (CHIEF_HOST_ORDER), applied to the uncapped base BEFORE the 32768 cap and compared for exact equality; managed-role and codex preload text stays byte-identical. This is an independent base-to-head
// comparison: base is test/fixtures/tool-config-9689364.txt, captured by running test/toolConfigFixture.ts unchanged on base 9689364 (the older oracle against the frozen
// tool-config-7178582.txt is red on base itself, for earlier plans' wording, so it cannot prove this). The frozen fixture is only hash-checked here, never regenerated.
const dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFile(join(dir, "test", "fixtures", name), "utf8");
const FROZEN_SHA256 = "c2946219b2c1632eaac697ade9f2c00d4cd7d5b5ebb8d0bb6b9ceea1317a4926";

describe("tool config: base 9689364 to head", () => {
  const load = async () => ({ base: JSON.parse(await fixture("tool-config-9689364.txt")) as ToolConfig, head: JSON.parse(await toolConfigFixture()) as ToolConfig });
  const mutated = async (edit: (head: ToolConfig) => void) => {
    const { base, head } = await load();
    edit(head);
    return () => compareToolConfig(base, head);
  };
  const chiefEntries = (head: ToolConfig) => head.entries.filter((entry) => entry.key.includes("| chief |"));
  const claudeChief = (head: ToolConfig, label = "short rules") => head.entries.find((entry) => entry.key === `${label} | chief | claude-code | planner true | research true`)!;
  const PRELOAD = "ToolSearch call: ";
  const preloadNames = (entry: ToolConfig["entries"][number]) => entry.instructions!.split("\n").find((line) => line.includes("ToolSearch"))!.split(`${PRELOAD}select:`)[1]!.split(",").map((name) => name.replace("mcp__bb-bridge__", ""));
  const editPreload = (entry: ToolConfig["entries"][number], change: (names: string[]) => string[]) => {
    const names = preloadNames(entry);
    entry.instructions = entry.instructions!.replace(`select:${names.map((name) => `mcp__bb-bridge__${name}`).join(",")}`, `select:${change(names).map((name) => `mcp__bb-bridge__${name}`).join(",")}`);
  };
  const editLine = (head: ToolConfig, prefix: string, change: (line: string) => string) => {
    for (const entry of chiefEntries(head)) entry.instructions = entry.instructions!.split("\n").map((line) => line.startsWith(prefix) ? change(line) : line).join("\n");
  };

  test("the frozen 7178582 fixture is unchanged", async () => {
    expect(createHash("sha256").update(await fixture("tool-config-7178582.txt")).digest("hex")).toBe(FROZEN_SHA256);
  });

  test("head equals base apart from the three listed edits and the #213 chief_attach delta (passes)", async () => {
    const { base, head } = await load();
    expect(() => compareToolConfig(base, head)).not.toThrow();
    // The #213 delta is really there: the comparison is not vacuous for it, and compareToolConfig leaves head untouched.
    expect(base.catalog["chief_attach"]).toBeUndefined();
    expect(head.catalog["chief_attach"]).toEqual(ATTACH_DEFINITION);
    expect(chiefEntries(head).every((entry) => entry.tools[entry.tools.indexOf("chief_coordinate") + 1] === "chief_attach")).toBe(true);
    // The #214 delta is really there too: exactly one optional boolean on chief_delegate, absent from base.
    expect(base.catalog["chief_delegate"]!.inputSchema.properties["evidenceOnly"]).toBeUndefined();
    expect(head.catalog["chief_delegate"]!.inputSchema.properties["evidenceOnly"]).toEqual(EVIDENCE_ONLY_PROPERTY);
    // The "Chief keeps tool search" delta is really there: includeOthers is new and optional, and every claude-code Chief preload line is now the exact select: list.
    expect(base.catalog["chief_roster"]!.inputSchema.properties["includeOthers"]).toBeUndefined();
    expect(head.catalog["chief_roster"]!.inputSchema.properties["includeOthers"]).toEqual(INCLUDE_OTHERS_PROPERTY);
    expect(head.catalog["chief_roster"]!.inputSchema.required ?? []).not.toContain("includeOthers");
    expect(head.catalog["chief_roster"]!.description).not.toBe(base.catalog["chief_roster"]!.description);
    const claudeChiefs = chiefEntries(head).filter((entry) => entry.key.includes("| claude-code |"));
    expect(claudeChiefs.length).toBe(4 * 2);
    for (const entry of claudeChiefs) {
      const names = preloadNames(entry);
      expect(names, entry.key).toEqual(CHIEF_HOST_ORDER.filter((name) => entry.tools.includes(name)));
      expect([...names].sort(), entry.key).toEqual([...entry.tools].sort());
      expect(entry.instructions, entry.key).not.toMatch(/\+chief|max_results/);
    }
    for (const entry of chiefEntries(head).filter((candidate) => candidate.key.includes("| codex |"))) expect(entry.instructions, entry.key).not.toContain("ToolSearch");
    // The three edits are really there: the comparison is not vacuous.
    expect(head.catalog["chief_delegate"]!.inputSchema.properties.kind!.description).not.toBe(base.catalog["chief_delegate"]!.inputSchema.properties.kind!.description);
    expect(head.catalog["chief_complete"]!.inputSchema.properties.skipReview!.description).not.toBe(base.catalog["chief_complete"]!.inputSchema.properties.skipReview!.description);
    const changed = head.entries.filter((entry, index) => entry.instructions !== base.entries[index]!.instructions);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((entry) => entry.key.includes("| chief |"))).toBe(true);
  });

  describe("negative controls: any other difference fails the comparison", () => {
    test("the lint/build/verify sentence dropped from the Skips line", async () => {
      const run = await mutated((head) => editLine(head, "- Skips:", (line) => line.replace(" Before a review skip, check its ready report shows lint/build and verify exit 0.", "")));
      expect(run).toThrow(": instructions");
    });
    test("the Skips line reworded beyond the authorized phrase", async () => {
      const run = await mutated((head) => editLine(head, "- Skips:", (line) => line.replace("your call per task", "your call")));
      expect(run).toThrow(": instructions");
    });
    test("the Tests, docs line reworded", async () => {
      const run = await mutated((head) => editLine(head, "- Tests, docs:", (line) => line.replace("only a Spec Writer changes docs/", "a Spec Writer changes docs/")));
      expect(run).toThrow(": instructions");
    });
    test("another core rule changed", async () => {
      const run = await mutated((head) => editLine(head, "- Evidence:", (line) => line.replace("never edits code", "edits code")));
      expect(run).toThrow("instructions");
    });
    test("the kind clause reworded", async () => {
      const run = await mutated((head) => { const kind = head.catalog["chief_delegate"]!.inputSchema.properties.kind!; kind.description = kind.description!.replace("for a docs change", "to change docs"); });
      expect(run).toThrow("chief_delegate.kind");
    });
    test("the skipReview clause reworded", async () => {
      const run = await mutated((head) => { const skip = head.catalog["chief_complete"]!.inputSchema.properties.skipReview!; skip.description = skip.description!.replace("the reply says so", "it is silent"); });
      expect(run).toThrow("chief_complete.skipReview");
    });
    test("a third tool description edited", async () => {
      const run = await mutated((head) => { head.catalog["chief_review"]!.description += " Extra."; });
      expect(run).toThrow("chief_review");
    });
    test("a tool schema field added", async () => {
      const run = await mutated((head) => { head.catalog["chief_complete"]!.inputSchema.properties["extra"] = { description: "x" }; });
      expect(run).toThrow("chief_complete");
    });
    // The cap boundary: the two authorized core-rule edits shorten the text by one character, so head exposes one more tail character of the 32768-capped worst case than base.
    const WORST = "worst case | chief | codex | planner true | research true";
    const worst = (head: ToolConfig) => head.entries.find((entry) => entry.key === WORST)!;
    test("the worst case is capped at exactly 32768 characters and ends where the base tail was shifted by one", async () => {
      const { base, head } = await load();
      const was = base.entries.find((entry) => entry.key === WORST)!.instructions!;
      expect([was.length, worst(head).instructions!.length]).toEqual([32768, 32768]);
      expect([was.slice(-10), worst(head).instructions!.slice(-10)]).toEqual(["- Project ", " Project r"]);
    });
    test("the final newly exposed byte changed (r to X)", async () => {
      const run = await mutated((head) => { const entry = worst(head); entry.instructions = `${entry.instructions!.slice(0, -1)}X`; });
      expect(run).toThrow(`${WORST}: instructions`);
    });
    test("the final newly exposed byte deleted (cap length 32767)", async () => {
      const run = await mutated((head) => { const entry = worst(head); entry.instructions = entry.instructions!.slice(0, -1); });
      expect(run).toThrow(`${WORST}: instructions`);
    });
    test("a byte appended past the cap (32769)", async () => {
      const run = await mutated((head) => { const entry = worst(head); entry.instructions += "r"; });
      expect(run).toThrow(`${WORST}: instructions`);
    });
    test("a middle byte of the capped project rules changed", async () => {
      const run = await mutated((head) => { const entry = worst(head); entry.instructions = entry.instructions!.replace("- Project rule text.\n- Project rule text.", "- Project rule text.\n- Project rule tXxt."); });
      expect(run).toThrow(`${WORST}: instructions`);
    });
    test("the uncapped short-rules Chief text with one byte appended", async () => {
      const run = await mutated((head) => { const entry = head.entries.find((candidate) => candidate.key.startsWith("short rules | chief |"))!; entry.instructions += "!"; });
      expect(run).toThrow("instructions");
    });
    test("a non-Chief role's instructions changed", async () => {
      const run = await mutated((head) => { const entry = head.entries.find((candidate) => candidate.key.includes("| worker |"))!; entry.instructions += "\n- extra"; });
      expect(run).toThrow("instructions");
    });
    test("chief_attach moved to the end of a plain Chief's tools", async () => {
      const run = await mutated((head) => { const entry = chiefEntries(head)[0]!; entry.tools = [...entry.tools.filter((name) => name !== "chief_attach"), "chief_attach"]; });
      expect(run).toThrow("chief_attach not right after chief_coordinate");
    });
    test("a duplicate chief_attach appended to a plain Chief's tools (codex)", async () => {
      const run = await mutated((head) => { chiefEntries(head).find((candidate) => candidate.key.includes("| codex |"))!.tools.push("chief_attach"); });
      expect(run).toThrow("key, tools or skills");
    });
    test("a duplicate chief_attach right after the first one in a plain Chief's tools", async () => {
      const run = await mutated((head) => { const entry = chiefEntries(head)[0]!; entry.tools.splice(entry.tools.indexOf("chief_attach"), 0, "chief_attach"); });
      expect(run).toThrow("key, tools or skills");
    });
    const delegate = (head: ToolConfig) => head.catalog["chief_delegate"]!.inputSchema as { required?: string[]; properties: Record<string, any> };
    test("chief_delegate.evidenceOnly missing", async () => {
      const run = await mutated((head) => { delete delegate(head).properties["evidenceOnly"]; });
      expect(run).toThrow("chief_delegate.evidenceOnly");
    });
    test("chief_delegate.evidenceOnly description changed", async () => {
      const run = await mutated((head) => { delegate(head).properties["evidenceOnly"].description += " Extra."; });
      expect(run).toThrow("chief_delegate.evidenceOnly");
    });
    test("chief_delegate.evidenceOnly made required", async () => {
      const run = await mutated((head) => { delegate(head).required = [...(delegate(head).required ?? []), "evidenceOnly"]; });
      expect(run).toThrow("chief_delegate.evidenceOnly");
    });
    test("an unexpected second optional property on chief_delegate", async () => {
      const run = await mutated((head) => { delegate(head).properties["dryRun"] = { type: "boolean", description: "Unexpected." }; });
      expect(run).toThrow("chief_delegate (description or schema)");
    });
    test("chief_delegate.evidenceOnly copied onto another tool", async () => {
      const run = await mutated((head) => { (head.catalog["chief_plan"]!.inputSchema.properties as Record<string, unknown>)["evidenceOnly"] = EVIDENCE_ONLY_PROPERTY; });
      expect(run).toThrow("chief_plan (description or schema)");
    });
    test("chief_attach added to a worker", async () => {
      const run = await mutated((head) => { head.entries.find((candidate) => candidate.key.includes("| worker |"))!.tools.push("chief_attach"); });
      expect(run).toThrow("chief_attach outside a plain Chief");
    });
    test("the chief_attach description changed by one character", async () => {
      const run = await mutated((head) => { head.catalog["chief_attach"]!.description = head.catalog["chief_attach"]!.description.replace("1-20", "1-21"); });
      expect(run).toThrow("chief_attach definition");
    });
    test("the chief_attach schema limit changed", async () => {
      const run = await mutated((head) => { (head.catalog["chief_attach"]!.inputSchema.properties["threadIds"] as any).maxItems = 21; });
      expect(run).toThrow("chief_attach definition");
    });
    test("chief_roster description: an unrelated edit", async () => {
      const run = await mutated((head) => { head.catalog["chief_roster"]!.description = head.catalog["chief_roster"]!.description.replace("leave them unless the user asks", "act on them freely"); });
      expect(run).toThrow("chief_roster description is not the base text with the one authorized clause");
    });
    test("chief_roster description: the authorized clause kept at base wording", async () => {
      const run = await mutated((head) => { head.catalog["chief_roster"]!.description = head.catalog["chief_roster"]!.description.replace("others' todos show as one count line (includeOthers: true lists them, tagged)", "others' todos are listed apart and tagged"); });
      expect(run).toThrow("chief_roster description is not the base text with the one authorized clause");
    });
    test("chief_roster.includeOthers missing", async () => {
      const run = await mutated((head) => { delete head.catalog["chief_roster"]!.inputSchema.properties["includeOthers"]; });
      expect(run).toThrow("chief_roster.includeOthers is not the planned optional boolean");
    });
    test("chief_roster.includeOthers description changed", async () => {
      const run = await mutated((head) => { head.catalog["chief_roster"]!.inputSchema.properties["includeOthers"]!.description += " Extra."; });
      expect(run).toThrow("chief_roster.includeOthers is not the planned optional boolean");
    });
    test("chief_roster.includeOthers made required", async () => {
      const run = await mutated((head) => { const schema = head.catalog["chief_roster"]!.inputSchema; schema.required = [...(schema.required ?? []), "includeOthers"]; });
      expect(run).toThrow("chief_roster.includeOthers is required");
    });
    test("a second new optional property on chief_roster", async () => {
      const run = await mutated((head) => { (head.catalog["chief_roster"]!.inputSchema.properties as Record<string, unknown>)["includeAll"] = { description: "Unexpected.", type: "boolean" }; });
      expect(run).toThrow("chief_roster (description or schema)");
    });
    test("chief_roster.includeOthers copied onto another tool", async () => {
      const run = await mutated((head) => { (head.catalog["chief_inspect"]!.inputSchema.properties as Record<string, unknown>)["includeOthers"] = INCLUDE_OTHERS_PROPERTY; });
      expect(run).toThrow("chief_inspect (description or schema)");
    });
    describe("the Chief preload line must be exactly select: plus the returned tools in the host's order", () => {
      const ENTRY = "short rules | chief | claude-code | planner true | research true";
      test("an extra name appended", async () => {
        const run = await mutated((head) => editPreload(claudeChief(head), (names) => [...names, "chief_extra"]));
        expect(run).toThrow(`${ENTRY}: instructions`);
      });
      test("two names swapped", async () => {
        const run = await mutated((head) => editPreload(claudeChief(head), (names) => { const [first, second, ...rest] = names; return [second!, first!, ...rest]; }));
        expect(run).toThrow(`${ENTRY}: instructions`);
      });
      test("a name dropped", async () => {
        const run = await mutated((head) => editPreload(claudeChief(head), (names) => names.slice(0, -1)));
        expect(run).toThrow(`${ENTRY}: instructions`);
      });
      test("a name repeated", async () => {
        const run = await mutated((head) => editPreload(claudeChief(head), (names) => [...names, names[0]!]));
        expect(run).toThrow(`${ENTRY}: instructions`);
      });
      test("the old keyword form restored", async () => {
        const run = await mutated((head) => { const entry = claudeChief(head); entry.instructions = entry.instructions!.replace(/select:\S+/, `query "+chief", max_results ${entry.tools.length}`); });
        expect(run).toThrow(`${ENTRY}: instructions`);
      });
      test("the preload line removed", async () => {
        const run = await mutated((head) => { const entry = claudeChief(head); entry.instructions = entry.instructions!.split("\n").filter((line) => !line.includes("ToolSearch")).join("\n"); });
        expect(run).toThrow(`${ENTRY}: instructions`);
      });
      test("a preload line added to a codex Chief", async () => {
        const run = await mutated((head) => { const entry = chiefEntries(head).find((candidate) => candidate.key.includes("| codex |"))!; entry.instructions = entry.instructions!.replace("\n", "\nIf your ToolSearch is needed: select:mcp__bb-bridge__chief_roster\n"); });
        expect(run).toThrow(`${ENTRY.replace("claude-code", "codex")}: instructions`);
      });
      test("a managed worker's preload line changed (a name dropped, then the keyword form)", async () => {
        const worker = (head: ToolConfig) => head.entries.find((candidate) => candidate.key.includes("| worker | claude-code |"))!;
        expect(await mutated((head) => { const entry = worker(head); entry.instructions = entry.instructions!.replace(/select:\S+/, "select:mcp__bb-bridge__chief_log"); })).toThrow(": instructions");
        expect(await mutated((head) => { const entry = worker(head); entry.instructions = entry.instructions!.replace(/select:\S+/, 'query "+chief", max_results 1'); })).toThrow(": instructions");
      });
      // A head that wholly restores a Chief's base text must not pass through an unchanged-instructions shortcut: the old keyword preload, the old Tests/Skips lines and the old cap tail are all rejected.
      test("a claude-code Chief's entire base instructions restored (short and capped cases)", async () => {
        for (const label of ["short rules", "worst case"]) {
          const key = `${label} | chief | claude-code | planner true | research true`;
          const { base, head } = await load();
          const entry = claudeChief(head, label);
          const was = claudeChief(base, label).instructions!;
          expect(was, label).toMatch(/query "\+chief", max_results \d+/);
          expect(was, label).not.toBe(entry.instructions);
          entry.instructions = was;
          expect(() => compareToolConfig(base, head), label).toThrow(`${key}: instructions`);
        }
      });
      test("a codex Chief's entire base instructions restored", async () => {
        const { base, head } = await load();
        const entry = chiefEntries(head).find((candidate) => candidate.key.includes("| codex |"))!;
        const was = base.entries.find((candidate) => candidate.key === entry.key)!.instructions!;
        expect(was).not.toBe(entry.instructions);
        entry.instructions = was;
        expect(() => compareToolConfig(base, head)).toThrow(`${entry.key}: instructions`);
      });
      test("the claude-code worst case: the final tail byte changed, deleted, or one appended", async () => {
        const worst = (head: ToolConfig) => claudeChief(head, "worst case");
        const [changed, deleted, appended] = [
          await mutated((head) => { const entry = worst(head); entry.instructions = `${entry.instructions!.slice(0, -1)}X`; }),
          await mutated((head) => { const entry = worst(head); entry.instructions = entry.instructions!.slice(0, -1); }),
          await mutated((head) => { const entry = worst(head); entry.instructions += "r"; }),
        ];
        for (const run of [changed, deleted, appended]) expect(run).toThrow("worst case | chief | claude-code | planner true | research true: instructions");
        // The longer select: line really moves the cap tail: both texts are 32768 characters, but head's ends earlier in the repeated rules than the base's.
        const { base, head } = await load();
        const [was, now] = [claudeChief(base, "worst case").instructions!, worst(head).instructions!];
        expect([was.length, now.length]).toEqual([32768, 32768]);
        expect(now.endsWith(was.slice(-10))).toBe(false);
      });
    });
    test("a tool dropped from a role", async () => {
      const run = await mutated((head) => { head.entries[0]!.tools = head.entries[0]!.tools.slice(1); });
      expect(run).toThrow("key, tools or skills");
    });
  });
});

describe("acceptCoreRuleTrim: the Skips line", () => {
  const BASE = "- Skips: your call per task, with a stated reason: the planner (unplannedReason), review (skipReview) or tests (chief_skip_tests, testsSkipped). Guidance, not a rule: small, low-risk changes suit a skip. Before a review skip, check its ready report shows lint/build and verify exit 0.";
  const HEAD = BASE.replace("Guidance, not a rule: small", "Small");
  const accept = (head: string) => acceptCoreRuleTrim(head, BASE);
  test("accepts exactly the authorized phrase change and hands back the base line", () => {
    expect(accept(HEAD)).toBe(BASE);
  });
  test("negative control: the lint/build/verify rule removed is rejected", () => {
    expect(() => accept(HEAD.replace(" Before a review skip, check its ready report shows lint/build and verify exit 0.", ""))).toThrow("must differ from base only by replacing");
  });
  test.each([
    ["a changed reason clause", HEAD.replace("with a stated reason", "with a reason")],
    ["a changed exit requirement", HEAD.replace("verify exit 0", "verify passed")],
    ["an appended sentence", `${HEAD} Always skip.`],
  ])("rejects %s", (_label, head) => {
    expect(() => accept(head)).toThrow();
  });
});

describe("acceptCoreRuleTrim: the Review, Fresh worker and Tests lines accept only the exact authorized edit", () => {
  const REVIEW = "- Review: only you start reviews, with chief_review, when a worker's ready alert says to; a plan gets one review of every branch after every wave is ready. chief_complete marks the PR ready itself (never run gh pr ready or glab mr update --ready) and needs the newest review to approve its current head, or skipReview. You mark ready a PR no worker owns, only on its branch reviewer's approve.";
  const FRESH = "- Fresh worker: a worker that has reported is never reused. All follow-up (unmet criteria, requested changes, next wave, rebase, restack, push, new task) goes to a fresh worker, tests to a fresh tester, via chief_delegate replaces: (same worktree, branch, PR; a plan chain has exactly one of each, so its next wave is a replaces: too); review and complete the successor.";
  const TESTS = "- Tests: workers and designers never write or run tests; a tester (kind: tester) does, as a plan's test wave or via chief_delegate (replaces: the worker, kind: tester). Spec waves: see the chief skill.";
  const REVIEW_HEAD = REVIEW.replace("when a worker's ready alert says to", "when a ready alert says to");
  const FRESH_HEAD = FRESH.replace("(same worktree, branch, PR; a plan chain has exactly one of each, so its next wave is a replaces: too)", "(same worktree, branch, PR; so is a plan chain's next wave)");
  const TESTS_HEAD = "- Tests, docs: only a tester writes or runs tests (a plan's test wave, or chief_delegate replaces: the worker, kind: tester); only a Spec Writer changes docs/, on every wave and unplanned work (chief skill).";
  test.each([["Review", REVIEW, REVIEW_HEAD], ["Fresh worker", FRESH, FRESH_HEAD], ["Tests, docs", TESTS, TESTS_HEAD]])("%s: the exact authorized edit is accepted and the base line comes back", (_name, base, head) => {
    expect(acceptCoreRuleTrim(head, base)).toBe(base);
  });
  test.each([
    ["Review: an appended sentence", REVIEW, `${REVIEW_HEAD} Never review.`],
    ["Review: an inserted clause", REVIEW, REVIEW_HEAD.replace("only you start reviews", "you never start reviews")],
    ["Review: a changed approval requirement", REVIEW, REVIEW_HEAD.replace("only on its branch reviewer's approve", "on any approve")],
    ["Review: a dropped sentence", REVIEW, REVIEW_HEAD.replace(" You mark ready a PR no worker owns, only on its branch reviewer's approve.", "")],
    ["Review: the base wording kept", REVIEW, `${REVIEW} Never review.`],
    ["Fresh worker: an appended sentence", FRESH, `${FRESH_HEAD} Reuse workers.`],
    ["Fresh worker: a changed rule", FRESH, FRESH_HEAD.replace("is never reused", "may be reused")],
    ["Fresh worker: a dropped clause", FRESH, FRESH_HEAD.replace("; review and complete the successor", "")],
    ["Fresh worker: the trim without the new words", FRESH, FRESH_HEAD.replace("so is a plan chain's next wave", "so is a plan chain's next wave, optionally")],
    ["Tests, docs: an appended sentence", TESTS, `${TESTS_HEAD} Chief may write tests.`],
    ["Tests, docs: a changed owner", TESTS, TESTS_HEAD.replace("only a tester writes", "any worker writes")],
  ])("rejects %s", (_name, base, head) => {
    expect(() => acceptCoreRuleTrim(head, base)).toThrow("must differ from base only by replacing");
  });
});
