import { replaceText } from "./harness";

// Reviewer-prompt wave (plan steps 1a and 6a): the only tool-schema differences against any older base are chief_review's `focus` description and
// `acceptedGaps`, and chief_report's plan wave flags. Each literal below is copied from the plan, not read from the implementation.
export const FOCUS_NEW = "What the reviewer should check. Never ask the reviewer to judge whether a verification gap blocks: decide it before the review. Pass a gap you accept in acceptedGaps; otherwise get the evidence first (for example a tester rerun).";
export const GAPS_NEW = "Verification gaps you accepted before this review, with your reason: the reviewer lists them under Manual Verification and never rejects on them alone.";
export const GAPS_PROPERTY = { description: GAPS_NEW, type: "string", minLength: 1, maxLength: 1_000 };
export const FOCUS_PROPERTY = { description: FOCUS_NEW, type: "string", maxLength: 4_000 };
export const PLAN_FLAGS_OLD = "{body, dependsOn, design?, test?, spec?}";
export const PLAN_FLAGS_NEW = "{body, dependsOn, design?, test?, spec?, feature?, reshape?}";
export const PLAN_CLAUSE_OLD = "in parallel with its worker. Chief receives";
export const PLAN_CLAUSE_NEW = "in parallel with its worker; feature: true marks an implementation wave that adds new behaviour; reshape: true marks a big feature's reshape wave. Chief receives";
export const FEATURE_PROPERTY = { description: "true on an implementation wave that adds new behaviour; its review runs the native-design check. Never on a test or design wave.", type: "boolean" };
export const RESHAPE_PROPERTY = { description: "true on the reshape (make-native) wave of a big feature. Never on a test or design wave.", type: "boolean" };

/** The older base's chief_report plan definition with the plan's named edits applied (exact counts). */
export function withPlanFlags(plan: { description: string; anyOf: { items?: { properties: Record<string, unknown> } }[] }) {
  plan.description = replaceText(replaceText(plan.description, PLAN_FLAGS_OLD, PLAN_FLAGS_NEW, 1), PLAN_CLAUSE_OLD, PLAN_CLAUSE_NEW, 1);
  const items = plan.anyOf[1]!.items!;
  items.properties = { ...items.properties, feature: FEATURE_PROPERTY, reshape: RESHAPE_PROPERTY };
}

/** For a preservation test against an older base: asserts head's text is the base text plus the named edits, then puts the base text back, so every other byte still compares. */
export function acceptReviewerToolDelta(now: any, was: any, name: string) {
  if (name === "chief_review") {
    const properties = now.inputSchema.properties;
    if (JSON.stringify(properties.acceptedGaps) !== JSON.stringify(GAPS_PROPERTY)) throw new Error("chief_review.acceptedGaps is not the planned schema");
    delete properties.acceptedGaps;
    if (JSON.stringify(properties.focus) !== JSON.stringify(FOCUS_PROPERTY)) throw new Error("chief_review.focus is not the base schema plus the planned description");
    properties.focus = was.inputSchema.properties.focus;
  }
  if (name === "chief_report") {
    // Reverse, exact counts: an older base's plan text differs elsewhere (other waves), so only the named additions come out.
    const plan = now.inputSchema.properties.plan;
    plan.description = replaceText(replaceText(plan.description, PLAN_FLAGS_NEW.replace("spec?}", "spec?, feature?, reshape?}"), PLAN_FLAGS_NEW.replace(", feature?, reshape?", ""), 1), PLAN_CLAUSE_NEW, PLAN_CLAUSE_OLD, 1);
    const { feature, reshape, ...rest } = plan.anyOf[1].items.properties;
    if (JSON.stringify(feature) !== JSON.stringify(FEATURE_PROPERTY) || JSON.stringify(reshape) !== JSON.stringify(RESHAPE_PROPERTY)) throw new Error("chief_report plan wave: feature/reshape are not the planned schema");
    plan.anyOf[1].items.properties = rest;
  }
}
