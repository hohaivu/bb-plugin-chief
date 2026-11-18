import { READY } from "./testerHelpers";

// The tester receipt format of docs/specs/plan-chains.md "Brief Contents": Tested commit, command lines, Coverage, Gaps, final `Receipt end.`.
export const TESTED = "9f3c2a1";
export const RECEIPT_LINES = [
  `Tested commit: ${TESTED}`,
  "bb-plugin-chief | ./node_modules/.bin/vitest run planChains.test.ts -t \"retest\" | 0 | 0 | planChains 12 passed",
  "Coverage: retest option -> planChains.test.ts \"retest receipt option\"",
  "Gaps: None",
  "Receipt end.",
];
export const RECEIPT_BODY = RECEIPT_LINES.join("\n");

/** A tester's ready result for a plan wave (it carries the Deviations heading) ending with `## Receipt <body>`. */
export const withReceipt = (body = RECEIPT_BODY) => `${READY}\n\n## Receipt\n${body}`;
/** The same receipt cut before its end line, as a clipped stored report would leave it. */
export const CUT_RESULT = withReceipt(RECEIPT_LINES.slice(0, -1).join("\n"));
export const COMPLETE_RESULT = withReceipt();

/** The retest route's sentence when the chain's newest ready tester has no complete receipt (plan-chains.md "Retest Debt"). */
export const NORMAL_MODE = " No complete tester receipt on this chain: rerun in normal Tester mode (no evidenceOnly).";
