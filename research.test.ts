import { describe, expect, test } from "vitest";
import { modelSelectionSchema, researchParams } from "./research";

describe("reasoningLevel validation", () => {
  const pick = { providerId: "codex", model: "gpt-6-astra" };

  test("a stored model selection accepts a provider-specific reasoning level", () => {
    expect(modelSelectionSchema.safeParse({ ...pick, reasoningLevel: "provider-auto" }).success).toBe(true);
  });

  test("a stored model selection rejects an empty reasoning level", () => {
    expect(modelSelectionSchema.safeParse({ ...pick, reasoningLevel: "" }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({ ...pick, reasoningLevel: "   " }).success).toBe(false);
  });

  test("the chief_research tool input still rejects a level outside the enum", () => {
    const call = (reasoningLevel: string) => researchParams.safeParse({
      mode: "survey", question: "q", items: ["a"],
      models: { scan: { provider: "codex", model: "gpt-6-astra", reasoningLevel } },
    }).success;
    expect(call("high")).toBe(true);
    expect(call("provider-auto")).toBe(false);
  });
});
