// Plan 2 contract 6 reworded Chief-facing tool texts: the Spec Writer runs beside its worker, in its own side worktree, and a side writer completes.
// A preservation test against an older base calls `acceptSpecLaneWording` first: it requires each reworded text to say the new thing and not the old
// thing, then puts the base text back, so every other byte of the tool still compares against base.
type Json = unknown;
/** [tool name, path inside the tool, words the new text must contain, words it must no longer contain] */
const REWORDED: [string, string, RegExp, RegExp][] = [
  ["chief_delegate", "description", /side worktree/, /one worktree:/],
  ["chief_delegate", "inputSchema.properties.kind.description", /explicit kind/, /defaults to spec-writer on its first hand-off/],
  ["chief_complete", "description", /covering approve/, /is never completed/],
  ["chief_complete", "inputSchema.properties.skipReview.description", /implementation-lane Spec Writer/, /Refused, like override, for a Spec Writer/],
  ["chief_skip_specs", "description", /once a Spec Writer was delegated on it/, /its worker runs first/],
  ["chief_report", "inputSchema.properties.plan.anyOf.1.items.properties.spec.description", /in parallel with its worker/, /before its worker/],
  ["chief_report", "inputSchema.properties.plan.description", /in parallel with its worker/, /before its worker runs/],
];
const at = (value: Json, path: string): any => path.split(".").reduce((node: any, key) => node?.[key], value);
const put = (value: Json, path: string, text: string) => {
  const keys = path.split(".");
  const parent = keys.slice(0, -1).reduce((node: any, key) => node[key], value) as any;
  parent[keys.at(-1)!] = text;
};
/** Restores base text for every reworded path of `now` that differs from `was`; `labels` names the rewording each tool must show. Mutates `now`. */
export function acceptSpecLaneWording(now: any, was: any, name: string) {
  for (const [tool, path, has, lacks] of REWORDED) {
    if (tool !== name) continue;
    const [next, old] = [at(now, path), at(was, path)];
    if (typeof next !== "string" || next === old) continue;
    if (!has.test(next) || lacks.test(next)) throw new Error(`${tool}.${path}: reworded text must match ${has} and not ${lacks}`);
    put(now, path, old);
  }
}
/** The planning line of Chief's instructions (host.ts) also moved: the Spec Writer is a side-worktree delegation beside the wave's worker. */
export function acceptPlanningLine(nowText: string, wasText: string) {
  const [next, old] = [nowText.split("\n"), wasText.split("\n")];
  const lines = next.map((line, index) => {
    if (line === old[index] || !line.startsWith("Planning is on.")) return line;
    if (!/Spec Writer is a fresh chief_delegate \(kind: spec-writer\) in its own side worktree/.test(line) || /Spec Writer runs first/.test(line)) throw new Error("planning line: wrong spec-lane wording");
    return old[index]!;
  });
  return lines.join("\n");
}
/** Chief's core rules (host.ts) were trimmed so a linked Chief's rules end inside the SDK cut. Each trim is one exact edit of the base line, so any other byte on the line still fails. */
const TEST_DOCS_LINE = "- Tests, docs: only a tester writes or runs tests (a plan's test wave, or chief_delegate replaces: the worker, kind: tester); only a Spec Writer changes docs/, on every wave and unplanned work (chief skill).";
const TRIMMED_RULES: [string, string, (old: string) => string][] = [
  ["- Fresh worker:", "- Fresh worker:", (old) => old.replace("(same worktree, branch, PR; a plan chain has exactly one of each, so its next wave is a replaces: too)", "(same worktree, branch, PR; so is a plan chain's next wave)")],
  ["- Review:", "- Review:", (old) => old.replace("when a worker's ready alert says to", "when a ready alert says to")],
  // The base line is "- Tests: ..."; the head line replaces it whole, so it must equal the one authorized text.
  ["- Tests, docs:", "- Tests:", () => TEST_DOCS_LINE],
  ["- Skips:", "- Skips:", (old) => old.replace("Guidance, not a rule: small", "Small")],
];
export function acceptCoreRuleTrim(nowText: string, wasText: string) {
  const old = wasText.split("\n");
  return nowText.split("\n").map((line, index) => {
    const rule = TRIMMED_RULES.find(([prefix]) => line.startsWith(prefix));
    if (!rule || line === old[index]) return line;
    const was = old[index] ?? "";
    if (!was.startsWith(rule[1]) || rule[2](was) === was || rule[2](was) !== line) throw new Error(`${rule[0]} must differ from base only by replacing the authorized wording`);
    return was;
  }).join("\n");
}
/** Asserts the final catalog says each reworded thing and none of the old, with no preservation baseline needed. */
export function assertSpecLaneWording(catalog: Record<string, any>) {
  for (const [tool, path, has, lacks] of REWORDED) {
    const text = at(catalog[tool], path);
    if (typeof text !== "string" || !has.test(text) || lacks.test(text)) throw new Error(`${tool}.${path}: must match ${has} and not ${lacks}`);
  }
}
/** The retest-debt feature adds chief_review's optional retestSkipped and a sentence of its description. Asserted on the head tool, then base text and schema win. */
export function acceptRetestDelta(now: any, was: any, name: string) {
  if (name !== "chief_review") return;
  const property = now.inputSchema.properties.retestSkipped;
  if (!property || !/waives every rerun/.test(property.description) || (now.inputSchema.required ?? []).includes("retestSkipped")) throw new Error("chief_review.retestSkipped: must be an optional field that waives every rerun");
  if (!/retestSkipped \(reason\) waives every listed rerun/.test(now.description) || /retestSkipped/.test(was.description)) throw new Error("chief_review.description: must name retestSkipped, and the base must not");
  delete now.inputSchema.properties.retestSkipped;
  now.description = was.description;
}

// #214: chief_delegate gains the optional boolean evidenceOnly, with this exact description (src/tools/shapes.ts). The one authorized delta, asserted exactly and then removed.
export const EVIDENCE_ONLY_PROPERTY = {
  description: "Tester only: the brief asks for run evidence (commands on given commits, exit statuses, comparison) and no commits. Not inherited through replaces:.",
  type: "boolean",
};
/** Asserts chief_delegate carries exactly the evidenceOnly property (optional, exact text), then removes it so the rest still compares against base. Other tools are untouched. Mutates `tool`. */
export function acceptEvidenceOnlyDelta(tool: any, name: string) {
  if (name !== "chief_delegate") return;
  const properties = tool.inputSchema.properties;
  if (JSON.stringify(properties.evidenceOnly) !== JSON.stringify(EVIDENCE_ONLY_PROPERTY) || (tool.inputSchema.required ?? []).includes("evidenceOnly")) throw new Error("chief_delegate.evidenceOnly: must be the one optional boolean with the #214 description");
  delete properties.evidenceOnly;
}

// #213: a plain, unlinked Chief gains chief_attach right after chief_coordinate. The full definition, asserted exactly by every tool-config oracle before it removes the tool.
export const ATTACH_DEFINITION = {
  description: "Coordinator only: link existing Chief threads as your children, in any project. Give the thread ids the owner names (1-20). One result line per id; a bad id never blocks the others. An id that is not a Chief row needs `bb chief adopt --thread <id>` first.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { threadIds: { minItems: 1, maxItems: 20, type: "array", items: { type: "string", minLength: 1 } } },
    required: ["threadIds"],
  },
};
