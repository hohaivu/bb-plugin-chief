// Docs-ownership wave (plan wave 1 of "only the Spec Writer edits docs/"): the preservation oracles compare head against older bases.
// These helpers accept ONLY the listed differences and throw on any other drift in the same place, then hand back the base bytes:
//   (a) the `## Docs ownership` paragraph on a review prompt (text from the plan, written here as an independent contract),
//   (b) review gate item (4) now pointing at it,
//   (c) the docs rule moved from the `## Spec` block into the `## Working contract`, and the Spec Writer's trailer and adoption lines.
export const OWNERSHIP_PARAGRAPH = (ids = "none") => `Only a Spec Writer changes docs/. The Spec Writers of this task: ${ids}. A docs/ commit is in scope only when its Chief-Spec-Writer trailer names one of them, or it lies inside one of their reported ranges (Base commit..Head commit, or Fold base..Fold head). Check with: git log --no-merges --format='%H %(trailers:key=Chief-Spec-Writer,valueonly)' <base>..<head> -- docs/. Any other docs/ commit is an ownership violation and is blocking. Exception: a later Spec Writer of this task lists that commit under "## Adopted docs commits" in its report, and the final docs/ content is correct. Then name it as a non-blocking note. A missing trailer means unknown ownership, not proof that a non-writer made the commit. The repair is never a worker change: it is a Spec Writer (kind: spec-writer).`;
export const OWNERSHIP_BLOCK = (ids = "none") => `\n\n## Docs ownership\n${OWNERSHIP_PARAGRAPH(ids)}`;
export const DOCS_RULE_NEW = "- Never change docs/: only a Spec Writer does, on every wave and on unplanned work. When the task needs a docs/ change, do not make it: list it under \"## Docs needed\" in your ready result and its summary. Chief routes it to a Spec Writer.";
export const DOCS_RULE_OLD = "- Never change docs/: only a Spec Writer does.";
export const TRAILER_LINE = "- Every commit you make carries the trailer Chief-Spec-Writer: commit with git commit --trailer \"Chief-Spec-Writer: $BB_THREAD_ID\". A rebase keeps it. Never squash or amend it away.";
export const ADOPT_LINE = "- When your mission names docs/ commits that another role made, check each one. Correct the docs in your own commits (a revert is a correction). List each such commit's sha under \"## Adopted docs commits\" in your ready result.";
const ITEM4_NEW = "(4) a docs/ ownership violation (see Docs ownership)";
const ITEM4_OLD = "(4) a docs/ change in a worker's, designer's or tester's own commit range";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IDS = "(?:none|thr_[A-Za-z0-9_]+(?:, thr_[A-Za-z0-9_]+)*)";
const OWNERSHIP_RE = new RegExp(escapeRe(OWNERSHIP_BLOCK("@@")).replace("@@", IDS), "g");
/** Review prompt text of head -> the same text on the older base. Removes every ownership block, and throws when a `## Docs ownership` heading
 * carries any text other than the contract paragraph (for "none" or a list of thread ids). Restores gate item (4). One text may hold many prompts. */
export function acceptOwnership(text: string): string {
  const headings = text.split("\n## Docs ownership\n").length - 1;
  const out = text.replace(OWNERSHIP_RE, () => "");
  if (out.split("## Docs ownership").length - 1 !== 0) throw new Error(`a Docs ownership heading differs from the contract paragraph (${headings} headings)`);
  return out.split(ITEM4_NEW).join(ITEM4_OLD);
}
/** Deep version for scenario objects (strings anywhere inside). */
export function acceptOwnershipDeep<T>(value: T): T {
  if (typeof value === "string") return acceptOwnership(value) as T;
  if (Array.isArray(value)) return value.map((entry) => acceptOwnershipDeep(entry)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, acceptOwnershipDeep(entry)])) as T;
  return value;
}
/** The docs rule moved from the `## Spec` block (old line) to the `## Working contract` (new line), and a Spec Writer brief gained the trailer and adoption lines.
 * Applied to BOTH head and base text of a brief transcript: every such line goes, every other byte must still match. */
export function dropDocsLines(text: string): string {
  const gone = new Set([DOCS_RULE_NEW, DOCS_RULE_OLD, TRAILER_LINE, ADOPT_LINE]);
  return text.split("\n").filter((line) => !gone.has(line)).join("\n");
}
/** A skipReview that could not read the branch history says so in the tool reply. A transcript line, dropped from head only. */
export const dropSkippedNote = (text: string) => text.split("\n").filter((line) => !/^docs\/ check skipped: .+; skipReview proceeded without it\.$/.test(line)).join("\n");
/** (b) The design-wave refusal now names the successor route. Head text -> base text; the route text is pinned by its own admission test. */
export const acceptDesignRefusal = (text: string) =>
  text.replace(/refused: Wave (\d+) is design-only: it changes no repository files\. Route its docs need to wave [^\n]+ once its worker has reported\./g, (_all, wave) => `refused: Wave ${wave} is design-only: no Spec Writer runs on it.`);
