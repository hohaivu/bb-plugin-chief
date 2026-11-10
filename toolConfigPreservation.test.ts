import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { disposeAll } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";
import { type ToolConfig, compareToolConfig, toolConfigFixture } from "./test/toolConfigFixture";
import { acceptCoreRuleTrim } from "./test/specLaneWording";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contract C13 (plan wave 1 "Only the Spec Writer edits docs/ everywhere", docs/specs/plan-chains.md): the tool configuration of every role changes in exactly three places
// against base 9689364: the chief_delegate `kind` clause, the chief_complete `skipReview` clause, and Chief's core-rule Tests/Skips lines. This is an independent base-to-head
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
  const editLine = (head: ToolConfig, prefix: string, change: (line: string) => string) => {
    for (const entry of chiefEntries(head)) entry.instructions = entry.instructions!.split("\n").map((line) => line.startsWith(prefix) ? change(line) : line).join("\n");
  };

  test("the frozen 7178582 fixture is unchanged", async () => {
    expect(createHash("sha256").update(await fixture("tool-config-7178582.txt")).digest("hex")).toBe(FROZEN_SHA256);
  });

  test("head equals base apart from the three listed edits (passes)", async () => {
    const { base, head } = await load();
    expect(() => compareToolConfig(base, head)).not.toThrow();
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
      expect(run).toThrow("the Skips line");
    });
    test("the Skips line reworded beyond the authorized phrase", async () => {
      const run = await mutated((head) => editLine(head, "- Skips:", (line) => line.replace("your call per task", "your call")));
      expect(run).toThrow("the Skips line");
    });
    test("the Tests, docs line reworded", async () => {
      const run = await mutated((head) => editLine(head, "- Tests, docs:", (line) => line.replace("only a Spec Writer changes docs/", "a Spec Writer changes docs/")));
      expect(run).toThrow("the Tests, docs line");
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
    test("a non-Chief role's instructions changed", async () => {
      const run = await mutated((head) => { const entry = head.entries.find((candidate) => candidate.key.includes("| worker |"))!; entry.instructions += "\n- extra"; });
      expect(run).toThrow("instructions");
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
