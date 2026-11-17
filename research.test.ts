import { describe, expect, test } from "vitest";
import { modelSelectionSchema, researchSettingsPatchSchema } from "./src/research/research";

describe("reasoningLevel validation", () => {
  const pick = { providerId: "codex", model: "gpt-6-astra" };

  test("a stored model selection accepts a provider-specific reasoning level", () => {
    expect(modelSelectionSchema.safeParse({ ...pick, reasoningLevel: "provider-auto" }).success).toBe(true);
  });

  test("a stored model selection rejects an empty reasoning level", () => {
    expect(modelSelectionSchema.safeParse({ ...pick, reasoningLevel: "" }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({ ...pick, reasoningLevel: "   " }).success).toBe(false);
  });
});

describe("research settings patch", () => {
  test("accepts only enabled; the removed cap and timeouts are rejected", () => {
    expect(researchSettingsPatchSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(researchSettingsPatchSchema.safeParse({ maxAgentCalls: 4 }).success).toBe(false);
    expect(researchSettingsPatchSchema.safeParse({ timeoutMinutes: { survey: 5 } }).success).toBe(false);
  });
});
