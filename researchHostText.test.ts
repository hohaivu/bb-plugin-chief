import { afterEach, describe, expect, test, vi } from "vitest";
import * as sdkTesting from "@get-bb/plugin-sdk/testing";
import { configurationContext, disposeAll, setup, start } from "./test/harness";
import { provideSdk } from "./test/sdk";

provideSdk(sdkTesting);
vi.mock("node:child_process", async () => (await import("./test/execMock")).childProcessMock());
afterEach(disposeAll);

// Chief's host text follows the two switches (docs/specs/research.md Chief tools and Design hand-off). The byte-level preservation against 16bbc52 lives in toolConfigPreservation.test.ts.
describe("Chief's host text across the planning and research switches", () => {
  async function configured(planner: boolean, research: boolean) {
    const state = await setup();
    const chief = await start(state);
    await state.harness.behavior.setSettings({ plannerEnabled: planner });
    await state.harness.behavior.callRpc("setResearchSettings", { enabled: research });
    const config = await state.harness.behavior.resolveAgentConfiguration(configurationContext(chief.threadId));
    return { tools: config.tools.map((tool: { name: string }) => tool.name), text: config.instructions as string };
  }
  const DESIGN_TEXT = ["design: true", "design discussion", "researchThreadId", "undesignedReason: "];

  // Contract (research.md Chief tools, Design hand-off): with planning and research on, Chief's text tells it to plan an approved design through chief_plan researchThreadId and to use design: true for features.
  // Regression: the old research paragraph that had no design hand-off.
  test("planning and research on: the text names design: true and the chief_plan hand-off", async () => {
    const { tools, text } = await configured(true, true);
    expect(tools).toEqual(expect.arrayContaining(["chief_plan", "chief_research"]));
    expect(text).toContain("design: true");
    expect(text).toContain("researchThreadId");
    expect(text).toContain("undesignedReason");
  });

  // Contract (research.md): research off removes the tool and every design line; the design hand-off text goes with it, and planning stays as it was. Regression: design text left behind with the switch off.
  test.each([[true], [false]])("research off (planning %s): no chief_research tool and no design text", async (planner) => {
    const { tools, text } = await configured(planner, false);
    expect(tools).not.toContain("chief_research");
    expect(text).not.toContain("chief_research");
    for (const part of ["design: true", "design discussion", "researchThreadId"]) expect(text).not.toContain(part);
    expect(text).not.toContain("undesignedReason");
  });

  // Contract (research.md Design hand-off): with planning off Chief has no chief_plan and its text never mentions chief_plan or its design input; the design goes to chief_delegate. Regression: a hand-off line telling Chief to call a tool it lacks.
  test("planning off, research on: no chief_plan tool or text, but the design: true guidance stays", async () => {
    const { tools, text } = await configured(false, true);
    expect(tools).not.toContain("chief_plan");
    expect(tools).toContain("chief_research");
    expect(text).not.toContain("chief_plan");
    expect(text).not.toContain("researchThreadId");
    expect(text).toContain("design: true");
  });

  test("planning off, research off: none of the design text", async () => {
    const { text } = await configured(false, false);
    for (const part of DESIGN_TEXT) expect(text).not.toContain(part);
  });
});
