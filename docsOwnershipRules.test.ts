import { afterEach, describe, expect, test, vi } from "vitest";
import { configurationContext, disposeAll, setup, start } from "./test/harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Contracts C12 and C13 (plan wave 1, "Only the Spec Writer edits docs/ everywhere"), read through Chief's real configuration.
// C12: Chief's core rules state the docs rule in the Tests/docs line, and the block fits the core-rules budget in any of its four `child` variants
//      (the SDK cuts instructions at 32768 chars; 4096 is the core-rules budget).
// C13: the two tool descriptions that changed say the new thing: the delegate `kind` text routes a docs change to a Spec Writer on every non-design wave,
//      and the `skipReview` text names the docs/ refusal and the skipped-check reply.
describe("docs ownership in Chief's configuration", () => {
  const MARKER = "# Project rules marker";
  /** Budget for the core block, separate from the Chief procedure and project rules. */
  const CORE_RULES_BUDGET = 4096;

  async function chiefConfiguration(planner: boolean, research: boolean) {
    const state = await setup({ rules: `${MARKER}\n- Keep rules small.` });
    const chief = await start(state);
    await state.harness.behavior.setSettings({ plannerEnabled: planner });
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: research });
    const configured = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId, "proj_1"));
    return configured as { tools: { name: string; description: string; inputSchema: any }[]; instructions: string };
  }
  const coreRules = (instructions: string) => {
    const from = instructions.indexOf("# Chief core rules (always apply)");
    const to = instructions.indexOf("\n\n# Chief procedure");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    expect(instructions.indexOf(`\n\n${MARKER}`)).toBeGreaterThan(to);
    return instructions.slice(from, to);
  };

  test.each([[true, true], [true, false], [false, true], [false, false]])("C12: planner %s, research %s: the Tests, docs line states the docs rule and the block fits the core-rules budget", async (planner, research) => {
    const { instructions } = await chiefConfiguration(planner, research);
    const rules = coreRules(instructions);
    const line = rules.split("\n").find((entry) => entry.startsWith("- Tests, docs:"));
    expect(line).toContain("only a Spec Writer changes docs/");
    expect(rules.length).toBeLessThanOrEqual(CORE_RULES_BUDGET);
  });

  describe("C13: tool text", () => {
    test("chief_delegate's kind text routes a docs change to a Spec Writer on every non-design wave and on unplanned work", async () => {
      const { tools } = await chiefConfiguration(true, false);
      const kind: string = tools.find((tool) => tool.name === "chief_delegate")!.inputSchema.properties.kind.description;
      expect(kind).toContain("spec-writer changes docs/ only");
      expect(kind).toContain("on any other plan wave except a design-only one it replaces the chain's current implementation row (the call a refusal names) for a docs change");
      expect(kind).toContain("on unplanned work it is opt-in, with or without replaces:");
      expect(kind).not.toContain("spec-bearing chain");
    });
    test("chief_complete's skipReview text names the docs/ refusal and says the skipped check is reported in the reply", async () => {
      const { tools } = await chiefConfiguration(true, false);
      const skip: string = tools.find((tool) => tool.name === "chief_complete")!.inputSchema.properties.skipReview.description;
      expect(skip).toContain("Also refused when the branch has a docs/ commit that no Spec Writer of this task is recorded on (Chief-Spec-Writer trailer); when that check cannot run, the reply says so.");
    });
  });
});
