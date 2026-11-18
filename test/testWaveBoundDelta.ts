import { replaceText } from "./harness";

// Test-wave size bound (#240): the only chief_report differences it adds against an older base are two clauses in the plan wave texts.
// Each literal is copied from the plan-wave schema texts of that change, never read from the implementation.
export const WAVE_TEST_CLAUSE = " A test wave lists at most 8 contracts and a `## Test files` list of 1 to 5 test files.";
export const PLAN_TEST_CLAUSE = " (a test wave lists at most 8 contracts and a `## Test files` list of 1 to 5 test files)";

/** Removes the test-wave bound clauses from head's chief_report (exact counts, applied only when present, so an older base passes through). */
export function acceptTestWaveBoundDelta(tool: any, name: string) {
  if (name !== "chief_report") return;
  const plan = tool.inputSchema.properties.plan;
  const wave = plan.anyOf[1].items.properties;
  if (wave.test.description.endsWith(WAVE_TEST_CLAUSE)) wave.test.description = wave.test.description.slice(0, -WAVE_TEST_CLAUSE.length);
  if (plan.description.includes(PLAN_TEST_CLAUSE)) plan.description = replaceText(plan.description, PLAN_TEST_CLAUSE, "", 1);
}
