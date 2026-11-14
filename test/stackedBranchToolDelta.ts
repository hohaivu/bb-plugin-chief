import { replaceText } from "./harness";

// Stacked-branch worktrees (plan thr_h3dmnirwzn, waves 1-2): the only tool-schema differences against an older base are the optional `branch` of chief_plan, chief_consult and
// chief_research, the optional `stackOn` of a chief_report plan wave (with its mention in the plan description), and one added sentence on chief_forge_init's `base`.
// Each literal is copied from the plan files, not read from the implementation.
const BRANCH_FIELD = { type: "string", minLength: 1, maxLength: 300 };
export const BRANCH_PROPERTIES: Record<string, { description: string; type: string; minLength: number; maxLength: number }> = {
  chief_plan: { description: "An open branch (for example a stacked pull request's head) to read instead of the project default: the thread runs in a fresh worktree based on it. For a plan, its chain heads stack on this branch.", ...BRANCH_FIELD },
  chief_consult: { description: "An open branch (for example a stacked pull request's head) to read instead of the project default: the thread runs in a fresh worktree based on it. Not with workerThreadId.", ...BRANCH_FIELD },
  chief_research: { description: "Chief only: run the researcher in a fresh worktree on this branch instead of your checkout.", ...BRANCH_FIELD },
};
export const STACK_ON_PROPERTY = {
  description: "Chain heads only (dependsOn: []): the 1-based earlier implementation wave, on another chain, whose changes this chain builds on. Its branch and pull request stack on that chain's branch, and it starts once wave k is ready.",
  type: "integer", minimum: -9007199254740991, maximum: 9007199254740991,
};
export const PLAN_STACK_OLD = "{body, dependsOn, design?";
export const PLAN_STACK_NEW = "{body, dependsOn, stackOn?, design?";
export const FORGE_BASE_SENTENCE = " Omit on a plan wave: a stacked or branch-based plan fixes it.";

/** Removes the stacked-branch additions from `tool` (a head definition), so every other byte still compares against the older base.
 * `strict` (default) first asserts each addition is exactly the planned one and optional; pass `strict: false` where the same comparison also runs on a base that lacks them. */
export function acceptStackedBranchDelta(tool: any, name: string, strict = true) {
  const properties = tool.inputSchema.properties;
  if (name in BRANCH_PROPERTIES) {
    if (strict && (JSON.stringify(properties.branch) !== JSON.stringify(BRANCH_PROPERTIES[name]) || (tool.inputSchema.required ?? []).includes("branch"))) throw new Error(`${name}.branch is not the one planned optional string`);
    delete properties.branch;
  }
  if (name === "chief_forge_init") {
    const base = properties.base;
    if (strict && !base.description.endsWith(FORGE_BASE_SENTENCE)) throw new Error("chief_forge_init.base lacks the planned sentence");
    if (base.description.endsWith(FORGE_BASE_SENTENCE)) base.description = base.description.slice(0, -FORGE_BASE_SENTENCE.length);
  }
  if (name === "chief_report") {
    const plan = properties.plan;
    const wave = plan.anyOf[1].items.properties;
    if (strict && (JSON.stringify(wave.stackOn) !== JSON.stringify(STACK_ON_PROPERTY) || (plan.anyOf[1].items.required ?? []).includes("stackOn"))) throw new Error("chief_report plan wave: stackOn is not the one planned optional integer");
    delete wave.stackOn;
    if (strict || plan.description.includes(PLAN_STACK_NEW)) plan.description = replaceText(plan.description, PLAN_STACK_NEW, PLAN_STACK_OLD, 1);
  }
}
