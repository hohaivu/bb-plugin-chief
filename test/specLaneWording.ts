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
/** Chief's core rules (host.ts) were trimmed so a linked Chief's rules end inside the 4096-char cut. Each trimmed line must show the new words and none of the old, then base wins. */
const TRIMMED_RULES: [string, RegExp, RegExp][] = [
  ["- Fresh worker:", /\(same worktree, branch, PR; so is a plan chain's next wave\)/, /a plan chain has exactly one of each/],
  ["- Review:", /when a ready alert says to/, /when a worker's ready alert says to/],
  ["- Tests, docs:", /^- Tests, docs: only a tester writes or runs tests \(a plan's test wave, or chief_delegate replaces: the worker, kind: tester\); only a Spec Writer changes docs\/, on every wave and unplanned work \(chief skill\)\.$/, /Spec waves: see the chief skill|a tester does, as a plan's test wave/],
  ["- Skips:", /Small, low-risk changes suit a skip\./, /Guidance, not a rule/],
];
export function acceptCoreRuleTrim(nowText: string, wasText: string) {
  const old = wasText.split("\n");
  return nowText.split("\n").map((line, index) => {
    const rule = TRIMMED_RULES.find(([prefix]) => line.startsWith(prefix));
    if (!rule || line === old[index]) return line;
    if (!rule[1].test(line) || rule[2].test(line)) throw new Error(`${rule[0]} trimmed wording must match ${rule[1]} and not ${rule[2]}`);
    return old[index]!;
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
