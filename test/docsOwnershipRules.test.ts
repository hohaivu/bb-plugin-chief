import { afterEach, describe, expect, test, vi } from "vitest";
import { configurationContext, disposeAll, setup, start } from "./harness";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { provideSdk } from "./sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./execMock")).childProcessMock());
afterEach(disposeAll);

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

  test.each([[true, true], [true, false], [false, true], [false, false]])("C12: planner %s, research %s: the core rules fit their size budget", async (planner, research) => {
    const { instructions } = await chiefConfiguration(planner, research);
    const rules = coreRules(instructions);
    expect(rules.length).toBeLessThanOrEqual(CORE_RULES_BUDGET);
  });

});
