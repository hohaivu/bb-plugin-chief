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

/** The same receipt with its command row replaced by `row` (undefined drops it); `Coverage` keeps four pipe-separated fields. */
const withRow = (row: string | undefined, coverage = "Coverage: API | UI | CLI | Docs") =>
  withReceipt([RECEIPT_LINES[0], ...(row === undefined ? [] : [row]), coverage, ...RECEIPT_LINES.slice(3)].join("\n"));
/** Incomplete receipts whose lines look like a receipt: none has a five-field command row (cwd, command, required exit, actual exit, counts). */
export const METADATA_ONLY_RESULT = withRow(undefined);
export const PIPES_ONLY_RESULT = withRow("| | | |");
export const BLANK_ROW_RESULT = withRow("   ");
export const MISSING_FIELDS_RESULT = withRow("bb-plugin-chief | npm test | 0");
export const FOUR_FIELD_RESULT = withRow("bb-plugin-chief | npm test | 0 | 0");
export const BLANK_COMMAND_RESULT = withRow("bb-plugin-chief | | 0 | 0 | 0");

/** A complete receipt whose command holds a real pipe, a `||` and a quoted pipe: the last three pipes still split off the exits and counts. */
export const PIPED_ROW = "bb-plugin-chief | npm test -- -t \"a|b\" | tee run.log || true | 0 | 0 | 12 passed";
export const PIPED_BODY = [RECEIPT_LINES[0], PIPED_ROW, ...RECEIPT_LINES.slice(2)].join("\n");
export const PIPED_RESULT = withReceipt(PIPED_BODY);
